import type { DatabaseReader, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, parseLocalId } from '../../../shared/contracts/index.ts';
import type { LocalAccount, LocalAccountId, TokenPair } from '../types.ts';

/**
 * user_local_account 的读写，只用 001 已有的列：id、username、password_hash、access_token、refresh_token。
 *
 * Token 暂存本表两列（技术方案原有字段）；以后改存 Android Keystore 时只替换
 * {@link LocalAccountRepository.saveTokens}、{@link LocalAccountRepository.tokens} 与
 * {@link LocalAccountRepository.clearTokens}。
 */

function invalid(field: string): never {
  throw new AppError('INVALID_DATABASE_RESULT', `本地账号字段 ${field} 无效。`);
}

function text(value: unknown, field: string): string {
  return typeof value === 'string' ? value : invalid(field);
}

function parseAccount(row: Record<string, unknown>): LocalAccount {
  return {
    id: parseLocalId<'user_local_account'>(row.id),
    username: text(row.username, 'username'),
    passwordHash: text(row.password_hash, 'password_hash'),
  };
}

export interface NewLocalAccount {
  username: string;
  passwordHash: string;
  tokens: TokenPair;
}

export class LocalAccountRepository {
  async any(reader: DatabaseReader): Promise<boolean> {
    return (await reader.query('SELECT 1 AS found FROM user_local_account LIMIT 1')).length > 0;
  }

  async findByUsername(reader: DatabaseReader, username: string): Promise<LocalAccount | null> {
    const rows = await reader.query('SELECT id, username, password_hash FROM user_local_account WHERE username = ?',
      [username]);
    return rows[0] ? parseAccount(rows[0]) : null;
  }

  async insert(tx: DatabaseTransaction, input: NewLocalAccount): Promise<LocalAccountId> {
    const result = await tx.run(
      'INSERT INTO user_local_account (username, password_hash, access_token, refresh_token) VALUES (?, ?, ?, ?)',
      [input.username, input.passwordHash, input.tokens.accessToken, input.tokens.refreshToken],
    );
    return parseLocalId<'user_local_account'>(result.lastInsertId);
  }

  async tokens(reader: DatabaseReader, id: LocalAccountId): Promise<TokenPair | null> {
    const rows = await reader.query('SELECT access_token, refresh_token FROM user_local_account WHERE id = ?', [id]);
    const row = rows[0];
    if (!row || typeof row.access_token !== 'string' || typeof row.refresh_token !== 'string') return null;
    return { accessToken: row.access_token, refreshToken: row.refresh_token };
  }

  /** 两个新 Token 在一个短事务里一起保存（契约 refreshTeacherToken）。 */
  async saveTokens(tx: DatabaseTransaction, id: LocalAccountId, tokens: TokenPair): Promise<void> {
    await this.#update(tx, 'UPDATE user_local_account SET access_token = ?, refresh_token = ? WHERE id = ?',
      [tokens.accessToken, tokens.refreshToken, id]);
  }

  /** refresh_token 已失效：清掉两枚 Token，"没有 Token"即表示云端凭证已失效，重启后仍然成立。 */
  async clearTokens(tx: DatabaseTransaction, id: LocalAccountId): Promise<void> {
    await this.#update(tx, 'UPDATE user_local_account SET access_token = NULL, refresh_token = NULL WHERE id = ?', [id]);
  }

  async #update(tx: DatabaseTransaction, sql: string, values: (string | number | null)[]): Promise<void> {
    if ((await tx.run(sql, values)).changes !== 1) throw new AppError('LOCAL_ACCOUNT_NOT_FOUND', '本地账号不存在。');
  }
}
