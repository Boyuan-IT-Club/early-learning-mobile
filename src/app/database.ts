import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Database } from '../infrastructure/database/database';
import { createCapacitorDriver } from '../infrastructure/database/capacitor-driver';
import { initialMigration } from '../infrastructure/database/migrate';
import { AppError } from '../shared/contracts/errors';
// 把数据表作为纯文本字符串导入
import initialSql from '../infrastructure/database/migrations/001_initial_sqlite.sql?raw';

let database: Database | undefined;

/** 唯一生产数据库组装点，模块不要自行调用 */
export function getDatabase(): Database {
  if (Capacitor.getPlatform() !== 'android') {
    throw new AppError('NATIVE_DATABASE_REQUIRED', '本地业务数据库需要 Android 环境。');
  }
  // 如果 database 为 undefined 或 null，创建新数据库实例，否则复用
  database ??= new Database(
    // SQLite插件的连接管理器，使用 CapacitorSQLite 作为底层驱动，SQLiteConnection 作为连接管理器，数据库名为 early_learning
    // 只在第一次调用这个函数时创建数据库实例，后续调用会复用同一个实例
    createCapacitorDriver(new SQLiteConnection(CapacitorSQLite), 'early_learning'),
    // 迁移列表，初始迁移为 initialMigration(initialSql)，将导入的 SQL 脚本作为参数传入
    [initialMigration(initialSql)],
  );
  return database;
}
