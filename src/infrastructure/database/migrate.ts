import { AppError } from '../../shared/contracts/errors.ts';
import type { DatabaseDriver, Migration } from './types.ts';

/** 保留现有可独立运行的 001 SQL，只在接入时移除其已知外层事务。 */
export function initialMigration(script: string): Migration {
  // 去除所有注释
  const sql = script.replace(/^--[^\r\n]*$/gm, '').trim();
  // 去除外层事务，确保 PRAGMA user_version 由本项目迁移器统一管理
  const match = /^PRAGMA foreign_keys = ON;\s*BEGIN IMMEDIATE;([\s\S]*)COMMIT;$/.exec(sql);
  if (!match) throw new AppError('INVALID_MIGRATION', '初始化 SQL 的事务边界不符合约定。');
  // match[1] 是去除外层事务后的 SQL 内容，trim() 去除首尾空白，只返回，不执行
  return { version: 1, sql: match[1].trim() };
}
// 在 open 中调用
export async function migrate(driver: DatabaseDriver, migrations: readonly Migration[]): Promise<void> {
  if (migrations.length === 0 || migrations.some((m, i) => m.version !== i + 1 || /(^|;)\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/i.test(m.sql.replace(/^--[^\r\n]*$/gm, '')))) {
    throw new AppError('INVALID_MIGRATION', '迁移必须连续编号，并由统一入口控制事务。');
  }
  await driver.execute('PRAGMA foreign_keys = ON;');
  if ((await driver.query('PRAGMA foreign_keys;'))[0]?.foreign_keys !== 1) {
    throw new AppError('FOREIGN_KEYS_DISABLED', '无法启用数据库外键约束。');
  }
  const check = await driver.query('PRAGMA quick_check;');
  if (check.length !== 1 || check[0].quick_check !== 'ok') {
    throw new AppError('DATABASE_INTEGRITY_FAILED', '数据库完整性检查失败，已保留原数据。');
  }
  const version = (await driver.query('PRAGMA user_version;'))[0]?.user_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > migrations.length) {
    throw new AppError('UNSUPPORTED_DATABASE_VERSION', '当前应用不支持此数据库版本。');
  }
  if (version === 0) {
    const objects = await driver.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%';");
    if (objects.length > 0) {
      throw new AppError('UNVERSIONED_DATABASE', '发现未登记迁移版本的已有数据库，需核对结构后迁移；原数据未修改。');
    }
  }
  for (const migration of migrations.filter(m => m.version > version)) {
    await driver.begin();
    let committing = false;
    try {
      // 核心步骤，migrate
      await driver.execute(migration.sql);
      if ((await driver.query('PRAGMA foreign_key_check;')).length > 0) {
        throw new AppError('DATABASE_INTEGRITY_FAILED', '迁移后的外键校验失败。');
      }
      await driver.execute(`PRAGMA user_version = ${migration.version};`);
      committing = true;
      await driver.commit();
    } catch {
      try {
        await driver.rollback();
      } catch {
        throw new AppError('DATABASE_ROLLBACK_FAILED', '迁移回滚失败，已停止使用此连接。');
      }
      if (committing) throw new AppError('DATABASE_COMMIT_FAILED', '迁移提交状态未确认，请重新打开数据库核对版本。');
      throw new AppError('DATABASE_MIGRATION_FAILED', '数据库迁移未完成，已回滚本次迁移。');
    }
  }
  if ((await driver.query('PRAGMA foreign_key_check;')).length > 0) {
    throw new AppError('DATABASE_INTEGRITY_FAILED', '数据库存在无效文件或业务关联，已停止使用。');
  }
}
