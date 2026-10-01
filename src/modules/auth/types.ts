import type { LocalId } from '../../shared/contracts/index.ts';

export type LocalAccountId = LocalId<'user_local_account'>;

/**
 * 本地账号，对应 001 的 user_local_account（不加列）。
 *
 * 一台平板可以有多个本地账号：契约没有旧账号的云端恢复接口，云端凭证失效后只能用新激活码注册新账号，
 * 旧账号的本地数据仍归旧账号所有。
 */
export interface LocalAccount {
  id: LocalAccountId;
  /** 服务端转小写后的用户名。 */
  username: string;
  passwordHash: string;
}

/**
 * 本机最近一次得知的云端可用性，只用于提示，不限制本地业务（契约：禁用不影响本地登录）。
 *
 * - OK：可用或尚未得知异常
 * - DISABLED / REVOKED：云端回 403 ACCOUNT_DISABLED / LICENSE_REVOKED；管理员处理后联网即恢复为 OK
 * - LOST：refresh_token 已失效（401 REFRESH_TOKEN_INVALID）。本地 Token 已清空，云端功能不再可用
 */
export type CloudStatus = 'OK' | 'DISABLED' | 'REVOKED' | 'LOST';

/** 已登录的会话。其他模块通过 {@link AuthService.requireSession} 取得。 */
export interface Session {
  /** user_local_account.id，供 case_info.teacher_id 等使用。 */
  teacherId: LocalAccountId;
  username: string;
  cloud: CloudStatus;
}

/** 启动后应该进入的页面。 */
export type AuthRoute =
  | { kind: 'REGISTER' }
  | { kind: 'LOGIN'; lastUsername: string | null }
  | { kind: 'HOME' };

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RegisterInput {
  activationCode: string;
  username: string;
  password: string;
}
