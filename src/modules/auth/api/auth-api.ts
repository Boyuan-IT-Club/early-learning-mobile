import type { HttpClient } from '../../../infrastructure/http/index.ts';
import { AppError } from '../../../shared/contracts/index.ts';
import type { TokenPair } from '../types.ts';

/**
 * 云端 `/api/auth/**` 接口（服务端 teacher 模块，契约见 01_账号与鉴权 5.1）。
 *
 * 响应在这里做运行时校验，不以类型断言代替（AGENTS.md）。
 */

export interface CloudSessionResult {
  userId: number;
  username: string;
  deviceRebound: boolean;
  tokens: TokenPair;
}

function invalid(): never {
  throw new AppError('INVALID_CLOUD_RESPONSE', '服务器返回的账号数据不完整。');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : invalid();
}

function str(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalid();
}

function tokens(data: Record<string, unknown>): TokenPair {
  const accessToken = str(data.access_token);
  const refreshToken = str(data.refresh_token);
  if (!accessToken.startsWith('at_') || !refreshToken.startsWith('rt_')) invalid();
  return { accessToken, refreshToken };
}

function session(value: unknown): CloudSessionResult {
  const data = record(value);
  const userId = data.user_id;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) invalid();
  return {
    userId,
    username: str(data.username),
    deviceRebound: data.device_rebound === true,
    tokens: tokens(data),
  };
}

export class AuthApi {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async verifyLicense(activationCode: string): Promise<void> {
    await this.#http.post('/api/auth/licenses/verify', { body: { activation_code: activationCode }, authenticated: false });
  }

  async register(activationCode: string, username: string, idempotencyKey: string): Promise<CloudSessionResult> {
    return session(await this.#http.post('/api/auth/register', {
      body: { activation_code: activationCode, username },
      authenticated: false,
      idempotencyKey,
    }));
  }

  async recover(username: string, recoveryCode: string, idempotencyKey: string): Promise<CloudSessionResult> {
    return session(await this.#http.post('/api/auth/recover', {
      body: { username, recovery_code: recoveryCode },
      authenticated: false,
      idempotencyKey,
    }));
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    return tokens(record(await this.#http.post('/api/auth/refresh', {
      body: { refresh_token: refreshToken },
      authenticated: false,
    })));
  }

  /** 已认证请求：成功说明云端账号可用；停用等状态由 HTTP 层的 accountSignal 落库。 */
  async me(): Promise<void> {
    await this.#http.get('/api/auth/me');
  }
}
