import { AppError } from '../../shared/contracts/errors.ts';

/**
 * 云端 HTTP 客户端：统一包络、Bearer 与设备号、access 过期时的串行刷新。
 *
 * infrastructure 不认识账号模块：Token 从哪来、刷新怎么做、账号状态怎么落库，都由注入的
 * {@link CredentialProvider} 负责（auth 模块实现）。
 *
 * 服务端包络：成功 `{code: 'OK', message, data}`，失败 `{code, message, data: null, details?}`。
 */

/** 网络层自己产生的错误码，服务端业务码不会以 CLIENT_ 开头。 */
export const CLIENT_ERROR = {
  NETWORK: 'CLIENT_NETWORK_ERROR',
  TIMEOUT: 'CLIENT_TIMEOUT',
  MALFORMED_RESPONSE: 'CLIENT_MALFORMED_RESPONSE',
} as const;

export interface ApiErrorDetails {
  field_path?: string;
  license_ids?: number[];
  [key: string]: unknown;
}

/** 云端请求失败。`code` 原样来自服务端，页面据此分支；message 是服务端的安全文案。 */
export class HttpError extends AppError {
  readonly status: number | undefined;
  readonly details: ApiErrorDetails | undefined;

  constructor(code: string, message: string, status?: number, details?: ApiErrorDetails) {
    super(code, message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }

  /** 连不上服务端（断网、超时、网关页）：可以稍后重试，本地数据不受影响。 */
  get offline(): boolean {
    return this.code === CLIENT_ERROR.NETWORK || this.code === CLIENT_ERROR.TIMEOUT;
  }
}

export interface CredentialProvider {
  /** 当前 access_token；没有账号或没有凭证时为 null。 */
  accessToken(): Promise<string | null>;
  /** 本机设备号（UUIDv4），每个请求都带。 */
  deviceId(): Promise<string>;
  /** 用 refresh_token 换新凭证并保存。成功返回 true；凭证已失效或账号不可用返回 false。 */
  refresh(): Promise<boolean>;
  /**
   * 账号类信号：已认证请求成功时传 'OK'，失败时传服务端错误码
   * （ACCOUNT_DISABLED、LICENSE_REVOKED、DEVICE_MISMATCH、REFRESH_TOKEN_INVALID…），由实现者落库。
   */
  accountSignal(code: string): Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  /** 带 Bearer；默认 true。注册、刷新、恢复等免登录接口传 false。 */
  authenticated?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
}

type Fetch = typeof fetch;

const ACCOUNT_CODES = new Set(['ACCOUNT_DISABLED', 'LICENSE_REVOKED', 'DEVICE_MISMATCH']);
const EXPIRED_CODES = new Set(['TOKEN_EXPIRED', 'TOKEN_INVALID']);

export class HttpClient {
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  #credentials: CredentialProvider | undefined;
  #refreshing: Promise<boolean> | null = null;

  constructor(baseUrl: string, fetchImpl: Fetch = (...args) => globalThis.fetch(...args)) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#fetch = fetchImpl;
  }

  /** 由 app 组装时注入；auth 模块自己也用本客户端调免登录接口，所以不在构造时传入。 */
  useCredentials(provider: CredentialProvider): void {
    this.#credentials = provider;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const authenticated = options.authenticated ?? true;
    const credentials = this.#credentials;
    if (!authenticated || !credentials) return this.#send<T>(method, path, options, null);

    const token = await credentials.accessToken();
    try {
      const result = await this.#send<T>(method, path, options, token);
      await credentials.accountSignal('OK');
      return result;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 401 && EXPIRED_CODES.has(error.code)) {
        // 串行刷新：同一时刻只有一个 refresh 在飞，其他请求等同一个结果（设计 5.10）
        if (!await this.#refreshOnce()) throw error;
        const retried = await this.#send<T>(method, path, options, await credentials.accessToken());
        await credentials.accountSignal('OK');
        return retried;
      }
      if (error.status === 403 && ACCOUNT_CODES.has(error.code)) {
        await credentials.accountSignal(error.code);
      }
      throw error;
    }
  }

  #refreshOnce(): Promise<boolean> {
    const credentials = this.#credentials;
    if (!credentials) return Promise.resolve(false);
    this.#refreshing ??= credentials.refresh().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  async #send<T>(method: string, path: string, options: RequestOptions, token: string | null): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.#credentials) headers['X-Device-Id'] = await this.#credentials.deviceId();
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    let response: Response;
    try {
      response = await this.#fetch(this.#baseUrl + path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new HttpError(
        aborted ? CLIENT_ERROR.TIMEOUT : CLIENT_ERROR.NETWORK,
        aborted ? '请求超时，请稍后重试。' : '无法连接服务器，请检查网络后重试。',
      );
    } finally {
      clearTimeout(timer);
    }

    const envelope = await readEnvelope(response);
    if (!envelope) {
      throw new HttpError(CLIENT_ERROR.MALFORMED_RESPONSE, '服务器返回了无法识别的内容。', response.status);
    }
    if (!response.ok || envelope.code !== 'OK') {
      throw new HttpError(envelope.code, envelope.message, response.status, envelope.details);
    }
    return envelope.data as T;
  }
}

interface Envelope {
  code: string;
  message: string;
  data: unknown;
  details?: ApiErrorDetails;
}

async function readEnvelope(response: Response): Promise<Envelope | null> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
  return candidate as unknown as Envelope;
}
