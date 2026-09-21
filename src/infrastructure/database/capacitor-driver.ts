import type { SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import { AppError } from '../../shared/contracts/errors.ts';
import type { DatabaseDriver, SqlRow, SqlValue } from './types.ts';

// 调用 SQLite 插件提供的底层函数，创建 Capacitor 数据库驱动，返回一个实现了 DatabaseDriver 接口的对象
export function createCapacitorDriver(manager: SQLiteConnection, name: string): DatabaseDriver {
  // 声明 connection 变量，类型为 SQLiteDBConnection 或 undefined
  let connection: SQLiteDBConnection | undefined;
  // 声明临时 current 函数，返回当前的 SQLiteDBConnection 实例，如果 connection 为 undefined，则抛出 AppError 异常
  function current(): SQLiteDBConnection {
    if (!connection) throw new AppError('DATABASE_NOT_OPEN', '数据库尚未打开。');
    return connection;
  }
  return {
    // 打开连接
    async open() {
      // 如果 connection 已经存在，说明数据库已经打开，直接返回，否则创建新的，不做加密处理
      connection = (await manager.isConnection(name, false)).result
        ? await manager.retrieveConnection(name, false)
        : await manager.createConnection(name, false, 'no-encryption', 1, false);
      // 不注册插件自动升级；PRAGMA user_version 由本项目迁移器统一管理。
      if (!(await connection.isDBOpen()).result) await connection.open();
    },
    // 关闭连接
    async close() {
      if ((await manager.isConnection(name, false)).result) await manager.closeConnection(name, false);
      connection = undefined;
    },
    // 执行 SQL 语句，不返回结果
    async execute(sql) { await current().execute(sql, false); },
    // 执行 SQL 查询，返回结果集
    async query(sql, values: readonly SqlValue[] = []) {
      const rows: unknown = (await current().query(sql, [...values])).values;
      if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
        throw new AppError('INVALID_DATABASE_RESULT', '数据库返回结构无效。');
      }
      return rows as SqlRow[];
    },
    // 执行 SQL 写入，返回写入结果
    async run(sql, values = []) {
      const result = (await current().run(sql, [...values], false)).changes;
      if (!result || typeof result.changes !== 'number' || !Number.isSafeInteger(result.changes) || result.changes < 0) {
        throw new AppError('INVALID_DATABASE_RESULT', '数据库写入结果无效。');
      }
      const id = result.lastId;
      return { changes: result.changes, ...(typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? { lastInsertId: id } : {}) };
    },
    // 开始事务
    async begin() { await current().beginTransaction(); },
    // 提交事务
    async commit() { await current().commitTransaction(); },
    // 回滚事务
    async rollback() { await current().rollbackTransaction(); },
  };
}
