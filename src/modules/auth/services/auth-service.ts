import type { Database } from '../../../infrastructure/database/index.ts';
import { HttpError } from '../../../infrastructure/http/index.ts';
import type { CredentialProvider } from '../../../infrastructure/http/index.ts';
import type { KeyValueStore } from '../../../infrastructure/storage/key-value-store.ts';
import { AppError, toIsoDateTime } from '../../../shared/contracts/index.ts';
import type { AuthApi, CloudSessionResult } from '../api/auth-api.ts';
import { checkPasswordPolicy, DEFAULT_ITERATIONS, hashPassword, verifyPassword } from '../password.ts';
import type { LocalAccountRepository } from '../repositories/local-account-repository.ts';
import type {
  AccountStatus, AuthRoute, CloudSession, LocalAccount, RecoverInput, RegisterInput, Session, TeacherProfile,
} from '../types.ts';

/**
 * 平板端账号与会话（01_账号与鉴权 v0.2 第 5.6–5.11 节）。
 *
 * - 注册、恢复要联网；日常登录、解锁完全离线，只比对本地密码哈希（C1、C2）。
 * - 停用、撤销、解绑状态由 HTTP 层的信号落库，断网重启后仍然有效；受限模式下可登录、查看、导出，
 *   不能新建或修改业务（D2）。其他模块写业务前调用 {@link AuthService.requireWritable}。
 * - 同时实现 {@link CredentialProvider}，供 HTTP 层取 Token、设备号与刷新。
 *
 * 事务内不做网络请求与密码哈希（AGENTS.md）：先算好、拿到云端结果，再进短事务落库。
 */

const DEVICE_ID_KEY = 'device-id';
const REGISTER_DRAFT_KEY = 'register-draft';
const RECOVER_DRAFT_KEY = 'recover-draft';

/** 连续失败 5 / 10 / 15 次及以上，分别锁 1 / 5 / 30 分钟（设计 5.8）。 */
function lockDurationMs(failures: number): number | null {
  if (failures < 5 || failures % 5 !== 0) return null;
  if (failures >= 15) return 30 * 60_000;
  if (failures >= 10) return 5 * 60_000;
  return 60_000;
}

const SIGNAL_STATUS: Record<string, AccountStatus> = {
  ACCOUNT_DISABLED: 'DISABLED',
  LICENSE_REVOKED: 'REVOKED',
  DEVICE_MISMATCH: 'UNBOUND',
};

interface Draft {
  key: string;
  identity: string;
}

export interface AuthServiceOptions {
  database: Database;
  repository: LocalAccountRepository;
  api: AuthApi;
  store: KeyValueStore;
  now?: () => Date;
  passwordIterations?: number;
  /** 切到后台超过这个时长，回来要本地解锁（设计 5.8，默认 15 分钟）。 */
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

  /** 启动或状态变化后应进入的页面（设计 5.6）。 */
  async route(): Promise<AuthRoute> {
    const account = await this.#account();
    if (!account) return { kind: 'ACTIVATE' };
    if (!this.#session) {
      return { kind: 'LOGIN', username: account.username, lockedUntil: this.#activeLock(account) };
    }
    return isProfileComplete(account.profile) ? { kind: 'HOME' } : { kind: 'PROFILE' };
  }

  // ---------------------------------------------------------------- 会话（对其他模块）

  getSession(): Session | null {
    return this.#session;
  }

  requireSession(): Session {
    if (!this.#session) throw new AppError('AUTH_NOT_LOGGED_IN', '请先登录。');
    return this.#session;
  }

  /** 受限模式（停用、撤销、解绑）下禁止新建和修改业务数据。 */
  requireWritable(): Session {
    const session = this.requireSession();
    if (session.accountStatus !== 'ACTIVE') {
      throw new AppError('AUTH_ACCOUNT_RESTRICTED', '账号当前处于受限状态，只能查看和导出已有数据。');
    }
    return session;
  }

  onSessionChange(listener: (session: Session | null) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  // ---------------------------------------------------------------- 激活与注册

  /** 注册前校验激活码（PRD 2.2-2）。失败抛 HttpError：LICENSE_UNAVAILABLE、INVALID_REQUEST、RATE_LIMITED。 */
  async verifyLicense(activationCode: string): Promise<void> {
    await this.#api.verifyLicense(activationCode.trim());
  }

  /**
   * 注册：云端校验激活码并建号（不上传密码），成功后在本地建账号并直接登录。
   *
   * 幂等键与"激活码 + 用户名"一起暂存：网络失败、App 被杀后重试沿用同一个键，服务端不会重复建号或占码。
   * 密码不暂存，重试需重新输入。
   */
  async register(input: RegisterInput): Promise<void> {
    if (await this.#account()) {
      throw new AppError('DEVICE_HAS_ACCOUNT', '本设备已绑定教师账号；换账号请联系管理员解绑。');
    }
    checkPasswordPolicy(input.password);
    const code = input.activationCode.trim();
    const username = input.username.trim();
    const key = this.#draftKey(REGISTER_DRAFT_KEY, `${code}|${username}`);

    let cloud: CloudSessionResult;
    try {
      cloud = await this.#api.register(code, username, key);
    } catch (error) {
      if (error instanceof HttpError && !error.offline && error.code !== 'DEPENDENCY_UNAVAILABLE') {
        // 业务性失败（用户名已占用、码不可用…）：这次输入作废，下次换新键
        this.#store.remove(REGISTER_DRAFT_KEY);
      }
      throw error;
    }

    const passwordHash = await hashPassword(input.password, this.#iterations);
    const at = this.#timestamp();
    const deviceId = await this.deviceId();
    const id = await this.#database.transaction(tx => this.#repository.insert(tx, {
      username: cloud.username,
      passwordHash,
      cloudUserId: cloud.userId,
      deviceId,
      tokens: cloud.tokens,
      at,
    }));
    this.#store.remove(REGISTER_DRAFT_KEY);
    this.#setSession({ teacherId: id, username: cloud.username, accountStatus: 'ACTIVE', cloudSession: 'OK' });
  }

  // ---------------------------------------------------------------- 登录、解锁、退出

  /** 离线登录：只比对本地密码哈希，不访问云端。 */
  async login(password: string): Promise<void> {
    const account = await this.#requireAccount();
    const lockedUntil = this.#activeLock(account);
    if (lockedUntil) {
      throw new AppError('LOGIN_LOCKED', `连续输错次数过多，请在 ${formatClock(lockedUntil)} 后再试。`);
    }
    const at = this.#timestamp();
    if (!await verifyPassword(password, account.passwordHash)) {
      const failures = account.failedLoginCount + 1;
      const duration = lockDurationMs(failures);
      const until = duration === null ? null : toIsoDateTime(new Date(this.#now().getTime() + duration));
      await this.#database.transaction(tx => this.#repository.saveLoginFailures(tx, account.id, failures, until, at));
      throw new AppError('WRONG_PASSWORD', until ? `密码错误，已锁定到 ${formatClock(until)}。` : '密码错误。');
    }
    if (account.failedLoginCount !== 0 || account.lockedUntil !== null) {
      await this.#database.transaction(tx => this.#repository.saveLoginFailures(tx, account.id, 0, null, at));
    }
    this.#backgroundAt = null;
    this.#setSession({
      teacherId: account.id,
      username: account.username,
      accountStatus: account.accountStatus,
      cloudSession: account.cloudSession,
    });
  }

  /** 退出只清内存会话：不删本地数据，也不删 Token（PRD 2.2-7）。 */
  logout(): void {
    this.#backgroundAt = null;
    this.#setSession(null);
  }

  /** App 切到后台时调用。 */
  markBackground(): void {
    if (this.#session) this.#backgroundAt = this.#now().getTime();
  }

  /** App 回到前台时调用；后台超时则锁定会话，回到登录页输入密码解锁。 */
  markForeground(): void {
    if (this.#backgroundAt !== null && this.#now().getTime() - this.#backgroundAt >= this.#unlockAfterMs) {
      this.logout();
    }
    this.#backgroundAt = null;
  }

  // ---------------------------------------------------------------- 恢复

  /**
   * 凭管理员签发的恢复码重新取得云端凭证，并重设本地密码。
   * 同一设备：更新本地账号；新设备或重装：新建本地账号（业务数据需另用离线备份恢复）。
   */
  async recover(input: RecoverInput): Promise<{ deviceRebound: boolean; createdLocalAccount: boolean }> {
    const username = input.username.trim();
    const existing = await this.#account();
    if (existing && existing.username !== username) {
      throw new AppError('DEVICE_HAS_ACCOUNT', `本设备已绑定账号 ${existing.username}，不能恢复其他账号。`);
    }
    checkPasswordPolicy(input.newPassword);
    const code = input.recoveryCode.trim();
    const key = this.#draftKey(RECOVER_DRAFT_KEY, `${username}|${code}`);

    let cloud: CloudSessionResult;
    try {
      cloud = await this.#api.recover(username, code, key);
    } catch (error) {
      if (error instanceof HttpError && !error.offline) this.#store.remove(RECOVER_DRAFT_KEY);
      throw error;
    }

    const passwordHash = await hashPassword(input.newPassword, this.#iterations);
    const at = this.#timestamp();
    const deviceId = await this.deviceId();
    const id = await this.#database.transaction(async tx => {
      if (existing) {
        await this.#repository.saveRecovery(tx, existing.id, passwordHash, cloud.userId, deviceId, cloud.tokens, at);
        return existing.id;
      }
      return this.#repository.insert(tx, {
        username: cloud.username, passwordHash, cloudUserId: cloud.userId, deviceId, tokens: cloud.tokens, at,
      });
    });
    this.#store.remove(RECOVER_DRAFT_KEY);
    this.#setSession({ teacherId: id, username: cloud.username, accountStatus: 'ACTIVE', cloudSession: 'OK' });
    return { deviceRebound: cloud.deviceRebound, createdLocalAccount: !existing };
  }

  // ---------------------------------------------------------------- 教师资料

  async profile(): Promise<TeacherProfile> {
    return (await this.#requireAccount()).profile;
  }

  /** 真实姓名与专业学习背景必填（PRD 2.3）；资料只存本地。受限模式下也允许补全资料。 */
  async saveProfile(profile: TeacherProfile): Promise<void> {
    const session = this.requireSession();
    const normalized = normalizeProfile(profile);
    if (!isProfileComplete(normalized)) {
      throw new AppError('PROFILE_INCOMPLETE', '真实姓名与专业学习背景为必填项。');
    }
    await this.#database.transaction(tx =>
      this.#repository.saveProfile(tx, session.teacherId, normalized, this.#timestamp()));
    this.#notify();
  }

  // ---------------------------------------------------------------- 状态同步

  /** 联网时确认云端账号状态；断网或云端不可用时静默跳过，本地状态保持不变。 */
  async syncStatus(): Promise<void> {
    const account = await this.#account();
    if (!account || account.cloudSession === 'LOST') return;
    try {
      await this.#api.me();
    } catch (error) {
      if (error instanceof HttpError) return;
      throw error;
    }
  }

  // ---------------------------------------------------------------- CredentialProvider

  async accessToken(): Promise<string | null> {
    const account = await this.#account();
    if (!account) return null;
    const tokens = await this.#database.read(reader => this.#repository.tokens(reader, account.id));
    return tokens?.accessToken ?? null;
  }

  /** 首次调用生成 UUIDv4；有本地账号时以账号上的设备号为准。 */
  async deviceId(): Promise<string> {
    const account = await this.#account();
    if (account?.deviceId) return account.deviceId;
    let value = this.#store.get(DEVICE_ID_KEY);
    if (!value) {
      value = crypto.randomUUID();
      this.#store.set(DEVICE_ID_KEY, value);
    }
    return value;
  }

  async refresh(): Promise<boolean> {
    const account = await this.#account();
    if (!account) return false;
    const current = await this.#database.read(reader => this.#repository.tokens(reader, account.id));
    if (!current) return false;
    try {
      const next = await this.#api.refresh(current.refreshToken);
      // 先落库再使用：进程若在这之前被杀，旧凭证 30 秒内重试仍能拿回同一组（契约宽限期）
      await this.#database.transaction(tx => this.#repository.saveTokens(tx, account.id, next, this.#timestamp()));
      await this.accountSignal('OK');
      return true;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.code === 'REFRESH_TOKEN_INVALID' || SIGNAL_STATUS[error.code]) await this.accountSignal(error.code);
      return false;
    }
  }

  async accountSignal(code: string): Promise<void> {
    const account = await this.#account();
    if (!account) return;
    let status: AccountStatus = account.accountStatus;
    let session: CloudSession = account.cloudSession;
    if (code === 'OK') {
      // 只有"停用"能被云端自动解除；撤销与解绑必须走恢复流程
      if (status === 'DISABLED') status = 'ACTIVE';
      session = 'OK';
    } else if (code === 'REFRESH_TOKEN_INVALID') {
      session = 'LOST';
    } else if (SIGNAL_STATUS[code]) {
      status = SIGNAL_STATUS[code];
    } else {
      return;
    }
    if (status === account.accountStatus && session === account.cloudSession) return;
    await this.#database.transaction(tx =>
      this.#repository.saveStatus(tx, account.id, status, session, this.#timestamp()));
    if (this.#session) this.#setSession({ ...this.#session, accountStatus: status, cloudSession: session });
  }

  // ---------------------------------------------------------------- 内部

  #account(): Promise<LocalAccount | null> {
    return this.#database.read(reader => this.#repository.find(reader));
  }

  async #requireAccount(): Promise<LocalAccount> {
    const account = await this.#account();
    if (!account) throw new AppError('LOCAL_ACCOUNT_NOT_FOUND', '本设备尚未注册教师账号。');
    return account;
  }

  #activeLock(account: LocalAccount): string | null {
    if (!account.lockedUntil) return null;
    return new Date(account.lockedUntil).getTime() > this.#now().getTime() ? account.lockedUntil : null;
  }

  /** 同一身份（同码同名、同名同恢复码）沿用已暂存的键；身份变了就是新操作，换键。 */
  #draftKey(storeKey: string, identity: string): string {
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

  #timestamp(): string {
    return toIsoDateTime(this.#now());
  }

  #setSession(session: Session | null): void {
    this.#session = session;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#session);
  }
}

export function isProfileComplete(profile: TeacherProfile): boolean {
  return Boolean(profile.realName?.trim()) && Boolean(profile.professionalBackground?.trim());
}

function normalizeProfile(profile: TeacherProfile): TeacherProfile {
  const clean = (value: string | null) => (value?.trim() ? value.trim() : null);
  const years = profile.yearsOfExperience;
  if (years !== null && (!Number.isSafeInteger(years) || years < 0 || years > 80)) {
    throw new AppError('INVALID_PROFILE', '工作年限须为 0–80 的整数。');
  }
  return {
    realName: clean(profile.realName),
    professionalBackground: clean(profile.professionalBackground),
    jobTitle: clean(profile.jobTitle),
    organization: clean(profile.organization),
    yearsOfExperience: years,
    workExperience: clean(profile.workExperience),
    teachingExpertise: clean(profile.teachingExpertise),
  };
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
