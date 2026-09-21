import { AppError } from '../../shared/contracts/errors.ts';
import { migrate } from './migrate.ts';
import type { DatabaseDriver, DatabaseReader, DatabaseTransaction, Migration, SqlValue } from './types.ts';

/** 每个实例独占一个 driver；应用仅在 app 组装处创建一个实例。 */
export class Database {
  // 全部为私有变量，外部不可直接访问。
  // 封装好的底层 Database 接口，接口实现在 capacitor-driver.ts
  readonly #driver: DatabaseDriver;
  readonly #migrations: readonly Migration[];
  #tail: Promise<unknown> = Promise.resolve();
  #ready = false;
  #unusable = false;
  // app 中调用这个构造函数
  constructor(driver: DatabaseDriver, migrations: readonly Migration[]) {
    this.#driver = driver;
    this.#migrations = migrations;
  }
  /** 保证操作的顺序性，避免并发问题。 */
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  // 建立连接并执行迁移
  async #open(): Promise<void> {
    if (this.#unusable) throw new AppError('DATABASE_UNAVAILABLE', '连接状态异常，请重新启动应用后重试。');
    if (this.#ready) return;
    try {
      // 核心部分，调用 driver 中已实现的 open 方法打开数据库连接，然后调用 migrate 方法执行迁移
      await this.#driver.open();
      await migrate(this.#driver, this.#migrations);
      this.#ready = true;
    } catch (error) {
      try { await this.#driver.close(); } catch { this.#unusable = true; }
      if (error instanceof AppError) throw error;
      throw new AppError('DATABASE_OPEN_FAILED', '本地数据库暂时无法打开，原数据未被删除。');
    }
  }

  // 接口，供应用层调用，初始化
  initialize(): Promise<void> {
    return this.#exclusive(() => this.#open());
  }
  // 接口，关闭数据库连接
  close(): Promise<void> {
    return this.#exclusive(async () => {
      try {
        await this.#driver.close();
        this.#ready = false;
        this.#unusable = false;
      } catch {
        this.#ready = false;
        this.#unusable = true;
        throw new AppError('DATABASE_CLOSE_FAILED', '数据库连接未能安全关闭。');
      }
    });
  }

  /** 一组读取独占连接，不会读到其他用例事务中尚未提交的中间结果。 */
  read<T>(work: (reader: DatabaseReader) => Promise<T>): Promise<T> {
    return this.#withScope(false, work);
  }

  /** 内部仓储直接复用 tx；回调内不得再次调用 Database 的入口，否则会等待自身。 */
  transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.#withScope(true, work);
  }

  #withScope<T>(transaction: boolean, work: (context: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      await this.#open();
      if (transaction) {
        try { await this.#driver.begin(); } catch {
          this.#unusable = true;
          throw new AppError('DATABASE_BEGIN_FAILED', '无法开始数据库事务。');
        }
      }
      let accepting = true;
      let failure: AppError | undefined;
      let pending: Promise<unknown> = Promise.resolve();
      const perform = <R>(sql: string, values: readonly SqlValue[], write: boolean, operation: () => Promise<R>): Promise<R> => {
        if (!accepting) return Promise.reject(new AppError('DATABASE_SCOPE_CLOSED', '数据库操作上下文已结束。'));
        const result = pending.then(async () => {
          if (failure) throw failure;
          try {
            // 仓储只接受一条参数化 DML / SELECT；事务控制和迁移 SQL 不对业务开放。
            const statement = sql.trim().replace(/;$/, '');
            if (statement.includes(';') || !(write ? /^(INSERT|UPDATE|DELETE)\s/i : /^SELECT\s/i).test(statement)) {
              throw new AppError('INVALID_SQL_OPERATION', '此操作不允许该 SQL 语句。');
            }
            if (values.some(value => value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))) {
              throw new AppError('INVALID_SQL_VALUE', 'SQL 参数须为字符串、有限数值或 null。');
            }
            return await operation();
          } catch (error) {
            failure = error instanceof AppError ? error : new AppError('DATABASE_OPERATION_FAILED', '数据库操作失败。');
            throw failure;
          }
        });
        // 即使调用方漏 await 或捕获了 SQL 错误，也必须排空操作并回滚整笔事务。
        pending = result.catch(() => undefined);
        return result;
      };
      const query: DatabaseReader['query'] = (sql, values = []) => perform(sql, values, false, () => this.#driver.query(sql, values));
      const run: DatabaseTransaction['run'] = (sql, values = []) => perform(sql, values, true, () => {
        if (!transaction) throw new AppError('WRITE_REQUIRES_TRANSACTION', '业务写入必须使用事务。');
        return this.#driver.run(sql, values);
      });
      const context = Object.freeze({ query, run });
      try {
        const result = await work(context);
        accepting = false;
        await pending;
        if (failure) throw failure;
        if (transaction) {
          try { await this.#driver.commit(); } catch {
            // 提交响应失败可能已经提交，不自动重放该业务操作。
            this.#unusable = true;
            throw new AppError('DATABASE_COMMIT_FAILED', '事务提交状态未确认，请重新打开数据库核对结果。');
          }
        }
        return result;
      } catch (error) {
        accepting = false;
        await pending;
        if (transaction) {
          try { await this.#driver.rollback(); } catch {
            this.#unusable = true;
            throw new AppError('DATABASE_ROLLBACK_FAILED', '事务回滚失败，已停止使用此连接。');
          }
        }
        throw error;
      } finally {
        accepting = false;
      }
    });
  }
}
