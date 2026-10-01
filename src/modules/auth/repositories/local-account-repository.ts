import type { DatabaseReader, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, parseLocalId } from '../../../shared/contracts/index.ts';
import type { AccountStatus, CloudSession, LocalAccount, LocalAccountId, TeacherProfile, TokenPair } from '../types.ts';

/**
 * user_local_account 的读写。一台设备最多一个账号（设计 D1），所以按"唯一一行"读取。
 *
 * Token 暂存本表 access_token / refresh_token 两列（技术方案原有字段）；
 * 以后改存 Android Keystore 时只替换 {@link LocalAccountRepository.saveTokens} 与 {@link LocalAccountRepository.tokens}。
 */

const ACCOUNT_STATUSES = new Set<AccountStatus>(['ACTIVE', 'DISABLED', 'REVOKED', 'UNBOUND']);
const CLOUD_SESSIONS = new Set<CloudSession>(['OK', 'LOST']);

const COLUMNS = `id, username, password_hash, cloud_user_id, device_id, account_status, cloud_session,
  status_synced_at, failed_login_count, locked_until, real_name, professional_background, job_title,
  organization, years_of_experience, work_experience, teaching_expertise`;

function invalid(field: string): never {
  throw new AppError('INVALID_DATABASE_RESULT', `本地账号字段 ${field} 无效。`);
}

function text(value: unknown, field: string): string {
  return typeof value === 'string' ? value : invalid(field);
}

function nullableText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : text(value, field);
}

function nullableInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : invalid(field);
}

function parseAccount(row: Record<string, unknown>): LocalAccount {
  const accountStatus = text(row.account_status, 'account_status') as AccountStatus;
  const cloudSession = text(row.cloud_session, 'cloud_session') as CloudSession;
  if (!ACCOUNT_STATUSES.has(accountStatus)) invalid('account_status');
  if (!CLOUD_SESSIONS.has(cloudSession)) invalid('cloud_session');
  return {
    id: parseLocalId<'user_local_account'>(row.id),
    username: text(row.username, 'username'),
    passwordHash: text(row.password_hash, 'password_hash'),
    cloudUserId: nullableInt(row.cloud_user_id, 'cloud_user_id'),
    deviceId: nullableText(row.device_id, 'device_id'),
    accountStatus,
    cloudSession,
    statusSyncedAt: nullableText(row.status_synced_at, 'status_synced_at'),
    failedLoginCount: nullableInt(row.failed_login_count, 'failed_login_count') ?? 0,
    lockedUntil: nullableText(row.locked_until, 'locked_until'),
    profile: {
      realName: nullableText(row.real_name, 'real_name'),
      professionalBackground: nullableText(row.professional_background, 'professional_background'),
      jobTitle: nullableText(row.job_title, 'job_title'),
      organization: nullableText(row.organization, 'organization'),
      yearsOfExperience: nullableInt(row.years_of_experience, 'years_of_experience'),
      workExperience: nullableText(row.work_experience, 'work_experience'),
      teachingExpertise: nullableText(row.teaching_expertise, 'teaching_expertise'),
    },
  };
}

export interface NewLocalAccount {
  username: string;
  passwordHash: string;
  cloudUserId: number;
  deviceId: string;
  tokens: TokenPair;
  at: string;
}

export class LocalAccountRepository {
  async find(reader: DatabaseReader): Promise<LocalAccount | null> {
    const rows = await reader.query(`SELECT ${COLUMNS} FROM user_local_account ORDER BY id LIMIT 2`);
    if (rows.length > 1) throw new AppError('MULTIPLE_LOCAL_ACCOUNTS', '本机存在多个教师账号，与"一台设备一个账号"的约定不符。');
    return rows[0] ? parseAccount(rows[0]) : null;
  }

  async insert(tx: DatabaseTransaction, input: NewLocalAccount): Promise<LocalAccountId> {
    const result = await tx.run(
      `INSERT INTO user_local_account (username, password_hash, cloud_user_id, device_id, access_token, refresh_token,
         account_status, cloud_session, status_synced_at, failed_login_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 'OK', ?, 0, ?, ?)`,
      [input.username, input.passwordHash, input.cloudUserId, input.deviceId, input.tokens.accessToken,
        input.tokens.refreshToken, input.at, input.at, input.at],
    );
    return parseLocalId<'user_local_account'>(result.lastInsertId);
  }

  async tokens(reader: DatabaseReader, id: LocalAccountId): Promise<TokenPair | null> {
    const rows = await reader.query('SELECT access_token, refresh_token FROM user_local_account WHERE id = ?', [id]);
    const row = rows[0];
    if (!row || typeof row.access_token !== 'string' || typeof row.refresh_token !== 'string') return null;
    return { accessToken: row.access_token, refreshToken: row.refresh_token };
  }

  async saveTokens(tx: DatabaseTransaction, id: LocalAccountId, tokens: TokenPair, at: string): Promise<void> {
    await this.#update(tx, 'UPDATE user_local_account SET access_token = ?, refresh_token = ?, updated_at = ? WHERE id = ?',
      [tokens.accessToken, tokens.refreshToken, at, id]);
  }

  async saveStatus(tx: DatabaseTransaction, id: LocalAccountId, status: AccountStatus, session: CloudSession, at: string): Promise<void> {
    await this.#update(tx,
      'UPDATE user_local_account SET account_status = ?, cloud_session = ?, status_synced_at = ?, updated_at = ? WHERE id = ?',
      [status, session, at, at, id]);
  }

  async saveLoginFailures(tx: DatabaseTransaction, id: LocalAccountId, count: number, lockedUntil: string | null, at: string): Promise<void> {
    await this.#update(tx,
      'UPDATE user_local_account SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?',
      [count, lockedUntil, at, id]);
  }

  /** 恢复成功：新密码、新凭证、恢复 ACTIVE、清零失败计数。 */
  async saveRecovery(tx: DatabaseTransaction, id: LocalAccountId, passwordHash: string, cloudUserId: number,
    deviceId: string, tokens: TokenPair, at: string): Promise<void> {
    await this.#update(tx,
      `UPDATE user_local_account SET password_hash = ?, cloud_user_id = ?, device_id = ?, access_token = ?, refresh_token = ?,
         account_status = 'ACTIVE', cloud_session = 'OK', status_synced_at = ?, failed_login_count = 0, locked_until = NULL,
         updated_at = ? WHERE id = ?`,
      [passwordHash, cloudUserId, deviceId, tokens.accessToken, tokens.refreshToken, at, at, id]);
  }

  async saveProfile(tx: DatabaseTransaction, id: LocalAccountId, profile: TeacherProfile, at: string): Promise<void> {
    await this.#update(tx,
      `UPDATE user_local_account SET real_name = ?, professional_background = ?, job_title = ?, organization = ?,
         years_of_experience = ?, work_experience = ?, teaching_expertise = ?, updated_at = ? WHERE id = ?`,
      [profile.realName, profile.professionalBackground, profile.jobTitle, profile.organization,
        profile.yearsOfExperience, profile.workExperience, profile.teachingExpertise, at, id]);
  }

  async #update(tx: DatabaseTransaction, sql: string, values: (string | number | null)[]): Promise<void> {
    if ((await tx.run(sql, values)).changes !== 1) throw new AppError('LOCAL_ACCOUNT_NOT_FOUND', '本地账号不存在。');
  }
}
