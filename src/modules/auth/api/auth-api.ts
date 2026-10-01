import type { HttpClient } from '../../../infrastructure/http/index.ts';
import { AppError } from '../../../shared/contracts/index.ts';
import type { TokenPair } from '../types.ts';

/**
 * 云端教师鉴权接口（契约 registerTeacher、refreshTeacherToken）。两个接口都免登录、都要求 Idempotency-Key。
 *
 * 响应在这里做运行时校验，不以类型断言代替（AGENTS.md）。
 */

/** 契约 `TokenPair`（只取平板用得到的字段）。 */
export interface CloudTokenPair {
  tokens: TokenPair;
  userId: number;
  /** 服务端转小写后的用户名。 */
  username: string;
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

function tokenPair(value: unknown): CloudTokenPair {
  const data = record(value);
  if (data.token_type !== 'Bearer') invalid();
  const user = record(data.user);
  const userId = user.id;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) invalid();
  return {
    tokens: { accessToken: str(data.access_token), refreshToken: str(data.refresh_token) },
    userId,
    username: str(user.username),
  };
}

export class AuthApi {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** 契约只收激活码与用户名；密码只在平板本地保存，不上传。 */
  async register(activationCode: string, username: string, idempotencyKey: string): Promise<CloudTokenPair> {
    return tokenPair(await this.#http.post('/api/auth/register', {
      body: { activation_code: activationCode, username },
      authenticated: false,
      idempotencyKey,
    }));
  }

  async refresh(refreshToken: string, idempotencyKey: string): Promise<CloudTokenPair> {
    return tokenPair(await this.#http.post('/api/auth/refresh', {
      body: { refresh_token: refreshToken },
      authenticated: false,
      idempotencyKey,
    }));
  }
}
