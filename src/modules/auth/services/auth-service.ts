import type { Database } from '../../../infrastructure/database/index.ts';
import { HttpError } from '../../../infrastructure/http/index.ts';
import type { CredentialProvider } from '../../../infrastructure/http/index.ts';
import type { KeyValueStore } from '../../../infrastructure/storage/key-value-store.ts';
import { AppError } from '../../../shared/contracts/index.ts';
import type { AuthApi, CloudTokenPair } from '../api/auth-api.ts';
import { normalizeActivationCode, normalizeUsername } from '../credentials.ts';
import { checkPasswordPolicy, DEFAULT_ITERATIONS, hashPassword, verifyPassword } from '../password.ts';
import type { LocalAccountRepository } from '../repositories/local-account-repository.ts';
import type { AuthRoute, CloudStatus, LocalAccountId, RegisterInput, Session } from '../types.ts';

/**
 * 平板端账号与会话（契约 registerTeacher、refreshTeacherToken；01_账号与鉴权 v0.3 第 8 节）。
 *
 * - 注册要联网：激活码 + 用户名上云，密码只在本地哈希保存。日常登录完全离线，只比对本地哈希。
 * - 云端停用、撤销、refresh 失效只影响云端功能，不限制本地业务（契约：禁用不影响本地登录）。
 * - 同时实现 {@link CredentialProvider}，供 HTTP 层取 Token 与刷新。
 *
 * 事务内不做网络请求与密码哈希（AGENTS.md）：先算好、拿到云端结果，再进短事务落库。
 */

const REGISTER_DRAFT_KEY = 'register-draft';
const LAST_USERNAME_KEY = 'last-username';
const refreshDraftKey = (id: LocalAccountId) => `refresh-draft:${id}`;

const SIGNAL_STATUS: Record<string, CloudStatus> = {
  ACCOUNT_DISABLED: 'DISABLED',
  LICENSE_REVOKED: 'REVOKED',
};

interface Draft {
  key: string;
  /** 输入的 SHA-256：草稿存在 localStorage，不放激活码或 refresh_token 原文。 */
  identity: string;
}

export interface AuthServiceOptions {
  database: Database;
  repository: LocalAccountRepository;
  api: AuthApi;
  store: KeyValueStore;
  now?: () => Date;
  passwordIterations?: number;
  /** 切到后台超过这个时长，回来要重新输入密码（默认 15 分钟）。 */
  unlockAfterMs?: number;
}

export class AuthService implements CredentialProvider {
  readonly #database: Database;
  readonly #repository: LocalAccountRepository;
  readonly #api: AuthApi;
  readonly #store: KeyValueStore;
  readonly #now: () => Date;
  readonly #iterations: number;
  readonly #unlockAfterMs: number;
  readonly #listeners = new Set<(session: Session | null) => void>();
  #session: Session | null = null;
  #backgroundAt: number | null = null;

  constructor(options: AuthServiceOptions) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#api = options.api;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#iterations = options.passwordIterations ?? DEFAULT_ITERATIONS;
    this.#unlockAfterMs = options.unlockAfterMs ?? 15 * 60_000;
  }

  // ---------------------------------------------------------------- 路由

  /** 启动或会话变化后应进入的页面：本机没有账号 → 注册；未登录 → 登录；否则工作台。 */
  async route(): Promise<AuthRoute> {
    if (this.#session) return { kind: 'HOME' };
    const hasAccount = await this.#database.read(reader => this.#repository.any(reader));
    return hasAccount ? { kind: 'LOGIN', lastUsername: this.#store.get(LAST_USERNAME_KEY) } : { kind: 'REGISTER' };
  }

  // ---------------------------------------------------------------- 会话（对其他模块）

  getSession(): Session | null {
    return this.#session;
  }

  requireSession(): Session {
    if (!this.#session) throw new AppError('AUTH_NOT_LOGGED_IN', '请先登录。');
    return this.#session;
  }

  onSessionChange(listener: (session: Session | null) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  // ---------------------------------------------------------------- 注册

  /**
   * 一步注册：云端校验激活码并建号（不上传密码），成功后在本地建账号并直接登录。
   *
   * 幂等键与"激活码 + 用户名"一起暂存：断网、App 被杀后原样重试沿用同一个键，服务端不会重复建号或占码；
   * 改了任一输入就是新的注册，换新键。密码不暂存。
   */
  async register(input: RegisterInput): Promise<void> {
    const username = normalizeUsername(input.username);
    const code = normalizeActivationCode(input.activationCode);
    checkPasswordPolicy(input.password);
    if (await this.#database.read(reader => this.#repository.findByUsername(reader, username))) {
      throw new AppError('LOCAL_USERNAME_EXISTS', '这台平板上已有同名账号，请直接登录。');
    }
    const key = await this.#draftKey(REGISTER_DRAFT_KEY, `${code}|${username}`);

    let cloud: CloudTokenPair;
    try {
      cloud = await this.#api.register(code, username, key);
    } catch (error) {
      if (error instanceof HttpError && !isRetryable(error)) {
        // 业务性失败（用户名已占用、码不可用、结果已过期…）：这次输入作废，下次换新键
        this.#store.remove(REGISTER_DRAFT_KEY);
      }
      throw error;
    }

    const passwordHash = await hashPassword(input.password, this.#iterations);
    const id = await this.#database.transaction(tx => this.#repository.insert(tx, {
      username: cloud.username, passwordHash, tokens: cloud.tokens,
    }));
    this.#store.remove(REGISTER_DRAFT_KEY);
    this.#signIn(id, cloud.username, 'OK');
  }

  // ---------------------------------------------------------------- 登录、解锁、退出

  /** 离线登录：只比对本地密码哈希，不访问云端。用户名不存在与密码错误给同一句提示。 */
  async login(rawUsername: string, password: string): Promise<void> {
    const username = rawUsername.trim().toLowerCase();
    const account = await this.#database.read(reader => this.#repository.findByUsername(reader, username));
    if (!account || !await verifyPassword(password, account.passwordHash)) {
      throw new AppError('WRONG_CREDENTIALS', '用户名或密码不正确。');
    }
    const tokens = await this.#database.read(reader => this.#repository.tokens(reader, account.id));
    this.#backgroundAt = null;
    this.#signIn(account.id, account.username, tokens ? 'OK' : 'LOST');
  }

  /** 退出只清内存会话：不删本地数据，也不删 Token。 */
  logout(): void {
    this.#backgroundAt = null;
    this.#setSession(null);
  }

  /** App 切到后台时调用。 */
  markBackground(): void {
    if (this.#session) this.#backgroundAt = this.#now().getTime();
  }

  /** App 回到前台时调用；后台超时则结束会话，回到登录页重新输入密码。 */
  markForeground(): void {
    if (this.#backgroundAt !== null && this.#now().getTime() - this.#backgroundAt >= this.#unlockAfterMs) {
      this.logout();
    }
    this.#backgroundAt = null;
  }

  // ---------------------------------------------------------------- CredentialProvider

  async accessToken(): Promise<string | null> {
    const session = this.#session;
    if (!session) return null;
    const tokens = await this.#database.read(reader => this.#repository.tokens(reader, session.teacherId));
    return tokens?.accessToken ?? null;
  }

  /**
   * 用 refresh_token 换一对新 Token，两枚在一个短事务里保存。HTTP 层保证同一时刻只有一个刷新在飞。
   *
   * 幂等键按"这一枚 refresh_token"暂存：断网后重试沿用同一个键，服务端重放同一组结果。
   */
  async refresh(): Promise<boolean> {
    const session = this.#session;
    if (!session) return false;
    const current = await this.#database.read(reader => this.#repository.tokens(reader, session.teacherId));
    if (!current) return false;
    const draftKey = refreshDraftKey(session.teacherId);

    let next: CloudTokenPair;
    try {
      next = await this.#refreshWithDraft(draftKey, current.refreshToken);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (!isRetryable(error)) this.#store.remove(draftKey);
      if (error.code === 'REFRESH_TOKEN_INVALID') {
        await this.#database.transaction(tx => this.#repository.clearTokens(tx, session.teacherId));
        this.#setCloud('LOST');
      } else if (SIGNAL_STATUS[error.code]) {
        this.#setCloud(SIGNAL_STATUS[error.code]);
      }
      return false;
    }
    await this.#database.transaction(tx => this.#repository.saveTokens(tx, session.teacherId, next.tokens));
    this.#store.remove(draftKey);
    this.#setCloud('OK');
    return true;
  }

  async accountSignal(code: string): Promise<void> {
    if (code === 'OK') {
      this.#setCloud('OK');
    } else if (SIGNAL_STATUS[code]) {
      this.#setCloud(SIGNAL_STATUS[code]);
    }
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 同键重放的结果已过期（409 SENSITIVE_RESULT_EXPIRED）说明服务端已轮换、但本机没收到：
   * 手里这枚成了"上一枚"，换新键再试一次即可在 30 秒宽限内取回同一组；过了宽限则 401。
   */
  async #refreshWithDraft(draftKey: string, refreshToken: string): Promise<CloudTokenPair> {
    const identity = refreshToken;
    try {
      return await this.#api.refresh(refreshToken, await this.#draftKey(draftKey, identity));
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'SENSITIVE_RESULT_EXPIRED') throw error;
      this.#store.remove(draftKey);
      return this.#api.refresh(refreshToken, await this.#draftKey(draftKey, identity));
    }
  }

  /** 同一输入沿用已暂存的键；输入变了就是新操作，换键。 */
  async #draftKey(storeKey: string, input: string): Promise<string> {
    const identity = await sha256Hex(input);
    const saved = this.#store.get(storeKey);
    if (saved) {
      try {
        const draft = JSON.parse(saved) as Draft;
        if (draft.identity === identity && typeof draft.key === 'string') return draft.key;
      } catch {
        // 损坏的草稿当作不存在
      }
    }
    const draft: Draft = { key: crypto.randomUUID(), identity };
    this.#store.set(storeKey, JSON.stringify(draft));
    return draft.key;
  }

  #signIn(teacherId: LocalAccountId, username: string, cloud: CloudStatus): void {
    this.#store.set(LAST_USERNAME_KEY, username);
    this.#setSession({ teacherId, username, cloud });
  }

  #setCloud(cloud: CloudStatus): void {
    const session = this.#session;
    if (!session || session.cloud === cloud) return;
    // LOST 只能由重新登录读库得出：之后不会再有成功的云端请求来"恢复"它
    if (session.cloud === 'LOST') return;
    this.#setSession({ ...session, cloud });
  }

  #setSession(session: Session | null): void {
    this.#session = session;
    for (const listener of this.#listeners) listener(this.#session);
  }
}

/** 断网、超时、依赖暂不可用：输入没问题，原样重试即可，保留幂等键。 */
function isRetryable(error: HttpError): boolean {
  return error.offline || error.code === 'DEPENDENCY_UNAVAILABLE' || error.code === 'RATE_LIMITED';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
