import type { LocalId } from '../../shared/contracts/index.ts';

/** 最近一次从云端同步到的账号状态（落库，断网重启仍有效）。 */
export type AccountStatus = 'ACTIVE' | 'DISABLED' | 'REVOKED' | 'UNBOUND';

/** 本机云端凭证是否可用。LOST：refresh_token 已失效，需管理员签发恢复码。 */
export type CloudSession = 'OK' | 'LOST';

export type LocalAccountId = LocalId<'user_local_account'>;

export interface TeacherProfile {
  realName: string | null;
  professionalBackground: string | null;
  jobTitle: string | null;
  organization: string | null;
  yearsOfExperience: number | null;
  workExperience: string | null;
  teachingExpertise: string | null;
}

export interface LocalAccount {
  id: LocalAccountId;
  username: string;
  passwordHash: string;
  cloudUserId: number | null;
  deviceId: string | null;
  accountStatus: AccountStatus;
  cloudSession: CloudSession;
  statusSyncedAt: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
  profile: TeacherProfile;
}

/** 已登录的会话。其他模块通过 {@link AuthService.requireSession} 等取得。 */
export interface Session {
  /** user_local_account.id，供 case_info.teacher_id 等使用。 */
  teacherId: LocalAccountId;
  username: string;
  accountStatus: AccountStatus;
  cloudSession: CloudSession;
}

/** 启动后应该进入的页面。 */
export type AuthRoute =
  | { kind: 'ACTIVATE' }
  | { kind: 'LOGIN'; username: string; lockedUntil: string | null }
  | { kind: 'PROFILE' }
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

export interface RecoverInput {
  username: string;
  recoveryCode: string;
  newPassword: string;
}
