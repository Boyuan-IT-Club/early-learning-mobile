/** SQLite 业务字段目前只使用 TEXT / INTEGER；二进制资源保存在文件系统。 */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;

export interface WriteResult {
  changes: number;
  /** 仅 INSERT 后有意义；UPDATE / DELETE 不使用此值。 */
  lastInsertId?: number;
}

export interface DatabaseReader {
  /** 返回 unknown 字段，仓储负责日期、枚举、JSON 等边界校验。 */
  query(sql: string, values?: readonly SqlValue[]): Promise<SqlRow[]>;
}

export interface DatabaseTransaction extends DatabaseReader {
  run(sql: string, values?: readonly SqlValue[]): Promise<WriteResult>;
}

/** 仅供平台适配、迁移器和测试使用；业务仓储不直接持有 driver。 */
export interface DatabaseDriver {
  open(): Promise<void>;
  close(): Promise<void>;
  execute(sql: string): Promise<void>;
  query(sql: string, values?: readonly SqlValue[]): Promise<SqlRow[]>;
  run(sql: string, values?: readonly SqlValue[]): Promise<WriteResult>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface Migration {
  version: number;
  /** 只放 DDL / DML，不包含事务控制或 PRAGMA；外层统一管理事务。 */
  sql: string;
}
