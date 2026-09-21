import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Database } from '../src/infrastructure/database/database.ts';
import { initialMigration, migrate } from '../src/infrastructure/database/migrate.ts';
import { createCapacitorDriver } from '../src/infrastructure/database/capacitor-driver.ts';

const initial = initialMigration(readFileSync(new URL('../src/infrastructure/database/migrations/001_initial_sqlite.sql', import.meta.url), 'utf8'));
const smallSchema = [{ version: 1, sql: 'CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE);' }];

// 仅测试驱动；应用仍使用 Android 插件，不在浏览器提供替代业务库。
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'early-learning-db-test-'));
  const path = join(folder, 'test.sqlite');
  let native;
  const driver = {
    async open() { native ??= new DatabaseSync(path); },
    async close() { native?.close(); native = undefined; },
    async execute(sql) { native.exec(sql); },
    async query(sql, values = []) { return native.prepare(sql).all(...values).map(row => ({ ...row })); },
    async run(sql, values = []) {
      const result = native.prepare(sql).run(...values);
      return { changes: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
    async begin() { native.exec('BEGIN IMMEDIATE;'); },
    async commit() { native.exec('COMMIT;'); },
    async rollback() { if (native.isTransaction) native.exec('ROLLBACK;'); },
  };
  t.after(async () => {
    await driver.close();
    // 只删除本测试明确创建的文件和空目录。
    rmSync(path, { force: true });
    rmdirSync(folder);
  });
  return driver;
}

function latch() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('首次迁移创建 18 张表，启用外键，重复启动和重开不丢失数据', async t => {
  const driver = fixture(t);
  const db = new Database(driver, [initial]);
  await Promise.all([db.initialize(), db.initialize()]);
  assert.equal((await driver.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'" )).length, 18);
  assert.deepEqual(await driver.query('PRAGMA user_version'), [{ user_version: 1 }]);
  assert.deepEqual(await driver.query('PRAGMA foreign_keys'), [{ foreign_keys: 1 }]);
  await db.transaction(tx => tx.run('INSERT INTO user_local_account (username, password_hash) VALUES (?, ?)', ['synthetic-user', 'test-only-hash']));
  await db.close();
  await db.initialize();
  assert.equal((await db.read(r => r.query('SELECT username FROM user_local_account')))[0].username, 'synthetic-user');
  await assert.rejects(db.transaction(tx => tx.run('INSERT INTO group_member (group_id, case_id) VALUES (?, ?)', [999, 999])), { code: 'DATABASE_OPERATION_FAILED' });
});

test('无版本旧库拒绝接管，未知较高版本拒绝降级，原数据保留', async t => {
  const driver = fixture(t);
  await driver.open();
  await driver.execute("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('synthetic');");
  await assert.rejects(new Database(driver, [initial]).initialize(), { code: 'UNVERSIONED_DATABASE' });
  await driver.open();
  assert.deepEqual(await driver.query('SELECT value FROM legacy'), [{ value: 'synthetic' }]);
  await driver.execute('PRAGMA user_version = 99');
  await assert.rejects(new Database(driver, [initial]).initialize(), { code: 'UNSUPPORTED_DATABASE_VERSION' });
  await driver.open();
  assert.deepEqual(await driver.query('SELECT value FROM legacy'), [{ value: 'synthetic' }]);
});

test('迁移失败同时回滚 DDL、数据和版本，修正迁移后可重试', async t => {
  const driver = fixture(t);
  await driver.open();
  await migrate(driver, smallSchema);
  await driver.run('INSERT INTO sample VALUES (?, ?)', [1, 'preserved']);
  const broken = { version: 2, sql: "CREATE TABLE extra (id INTEGER); INSERT INTO sample VALUES (2, 'new'); INSERT INTO missing VALUES (1);" };
  await assert.rejects(migrate(driver, [...smallSchema, broken]), { code: 'DATABASE_MIGRATION_FAILED' });
  assert.deepEqual(await driver.query('PRAGMA user_version'), [{ user_version: 1 }]);
  assert.deepEqual(await driver.query('SELECT value FROM sample'), [{ value: 'preserved' }]);
  assert.deepEqual(await driver.query("SELECT name FROM sqlite_master WHERE name = 'extra'"), []);
  await migrate(driver, [...smallSchema, { version: 2, sql: 'CREATE TABLE extra (id INTEGER);' }]);
  assert.deepEqual(await driver.query('PRAGMA user_version'), [{ user_version: 2 }]);
});

test('非法迁移序号、嵌套事务及已损坏外键在启动时拒绝', async t => {
  const driver = fixture(t);
  await driver.open();
  for (const migrations of [[], [{ version: 2, sql: 'SELECT 1;' }], [{ version: 1, sql: 'BEGIN; CREATE TABLE x(id); COMMIT;' }]]) {
    await assert.rejects(migrate(driver, migrations), { code: 'INVALID_MIGRATION' });
  }
  await driver.execute('PRAGMA foreign_keys = OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (7); PRAGMA user_version = 1;');
  await assert.rejects(migrate(driver, smallSchema), { code: 'DATABASE_INTEGRITY_FAILED' });
});

test('多个仓储复用同一上下文，业务异常时所有写入一起回滚', async t => {
  const db = new Database(fixture(t), smallSchema);
  const repoA = tx => tx.run('INSERT INTO sample VALUES (?, ?)', [1, 'a']);
  const repoB = tx => tx.run('INSERT INTO sample VALUES (?, ?)', [2, 'b']);
  await assert.rejects(db.transaction(async tx => {
    await repoA(tx);
    await repoB(tx);
    throw new Error('synthetic business failure');
  }), /synthetic business failure/);
  assert.deepEqual(await db.read(r => r.query('SELECT * FROM sample')), []);
  await db.transaction(async tx => { await repoA(tx); await repoB(tx); });
  assert.equal((await db.read(r => r.query('SELECT * FROM sample'))).length, 2);
});

test('吞掉 SQL 异常仍回滚整笔事务，原始 SQL 错误不会对外泄漏', async t => {
  const db = new Database(fixture(t), smallSchema);
  await assert.rejects(db.transaction(async tx => {
    await tx.run('INSERT INTO sample VALUES (?, ?)', [1, 'private-test-value']);
    await tx.run('INSERT INTO sample VALUES (?, ?)', [2, 'private-test-value']).catch(() => undefined);
  }), error => error.code === 'DATABASE_OPERATION_FAILED' && !error.message.includes('private-test-value'));
  assert.deepEqual(await db.read(r => r.query('SELECT * FROM sample')), []);
});

test('漏 await 的已排队操作在提交前完成，上下文不可在事务结束后复用', async t => {
  const db = new Database(fixture(t), smallSchema);
  let saved;
  await db.transaction(async tx => {
    saved = tx;
    void tx.run('INSERT INTO sample VALUES (?, ?)', [1, 'queued']);
  });
  assert.equal((await db.read(r => r.query('SELECT * FROM sample'))).length, 1);
  await assert.rejects(saved.run('INSERT INTO sample VALUES (?, ?)', [2, 'late']), { code: 'DATABASE_SCOPE_CLOSED' });
  await assert.rejects(db.transaction(async tx => {
    void tx.run('INSERT INTO sample VALUES (?, ?)', [2, 'queued']);
  }), { code: 'DATABASE_OPERATION_FAILED' });
});

test('并发事务、读取、关闭按顺序执行，读取不暴露待回滚数据', async t => {
  const db = new Database(fixture(t), smallSchema);
  const entered = latch();
  const release = latch();
  const first = db.transaction(async tx => {
    await tx.run('INSERT INTO sample VALUES (?, ?)', [1, 'uncommitted']);
    entered.resolve();
    await release.promise;
    throw new Error('abort');
  });
  const rejected = assert.rejects(first, /abort/);
  await entered.promise;
  const read = db.read(r => r.query('SELECT * FROM sample'));
  const second = db.transaction(tx => tx.run('INSERT INTO sample VALUES (?, ?)', [2, 'committed']));
  const closed = db.close();
  release.resolve();
  await rejected;
  assert.deepEqual(await read, []);
  await second;
  await closed;
  assert.deepEqual(await db.read(r => r.query('SELECT value FROM sample')), [{ value: 'committed' }]);
});

test('仓储不能自行提交、建表、多语句执行或使用非 SQLite 参数', async t => {
  const db = new Database(fixture(t), smallSchema);
  for (const sql of ['COMMIT', 'CREATE TABLE forbidden(id)', 'INSERT INTO sample VALUES (1, 2); DELETE FROM sample']) {
    await assert.rejects(db.transaction(tx => tx.run(sql)), { code: 'INVALID_SQL_OPERATION' });
  }
  await assert.rejects(db.transaction(tx => tx.run('INSERT INTO sample VALUES (?, ?)', [1, undefined])), { code: 'INVALID_SQL_VALUE' });
  await assert.rejects(db.read(r => r.run('DELETE FROM sample')), { code: 'WRITE_REQUIRES_TRANSACTION' });
  assert.deepEqual(await db.read(r => r.query('SELECT * FROM sample')), []);
});

test('提交响应丢失时停止连接且不重放，重开后可核对已提交结果', async t => {
  const driver = fixture(t);
  const db = new Database(driver, smallSchema);
  await db.initialize();
  const commit = driver.commit;
  let commits = 0;
  driver.commit = async () => { commits++; await commit(); throw new Error('lost response'); };
  await assert.rejects(db.transaction(tx => tx.run('INSERT INTO sample VALUES (?, ?)', [1, 'once'])), { code: 'DATABASE_COMMIT_FAILED' });
  await assert.rejects(db.read(r => r.query('SELECT * FROM sample')), { code: 'DATABASE_UNAVAILABLE' });
  assert.equal(commits, 1);
  driver.commit = commit;
  await db.close();
  assert.deepEqual(await db.read(r => r.query('SELECT value FROM sample')), [{ value: 'once' }]);
});

test('回滚失败后停止连接，关闭重开清理未提交事务', async t => {
  const driver = fixture(t);
  const db = new Database(driver, smallSchema);
  await db.initialize();
  const rollback = driver.rollback;
  driver.rollback = async () => { throw new Error('rollback failure'); };
  await assert.rejects(db.transaction(async tx => {
    await tx.run('INSERT INTO sample VALUES (?, ?)', [1, 'not-committed']);
    throw new Error('abort');
  }), { code: 'DATABASE_ROLLBACK_FAILED' });
  await assert.rejects(db.initialize(), { code: 'DATABASE_UNAVAILABLE' });
  driver.rollback = rollback;
  await db.close();
  assert.deepEqual(await db.read(r => r.query('SELECT * FROM sample')), []);
});

test('Capacitor 适配禁用隐式事务，复用连接并验证插件返回结构', async () => {
  const calls = [];
  let registered = false;
  let opened = false;
  const connection = {
    async isDBOpen() { return { result: opened }; },
    async open() { opened = true; calls.push('open'); },
    async execute(...args) { calls.push(['execute', ...args]); },
    async query() { return { values: [] }; },
    async run(...args) { calls.push(['run', ...args]); return { changes: { changes: 1, lastId: 7 } }; },
    async beginTransaction() { calls.push('begin'); },
    async commitTransaction() { calls.push('commit'); },
    async rollbackTransaction() { calls.push('rollback'); },
  };
  const manager = {
    async isConnection() { return { result: registered }; },
    async createConnection(...args) { registered = true; calls.push(['create', ...args]); return connection; },
    async retrieveConnection() { calls.push('retrieve'); return connection; },
    async closeConnection() { registered = false; opened = false; calls.push('close'); },
  };
  const driver = createCapacitorDriver(manager, 'test-only');
  await driver.open();
  await driver.open();
  await driver.begin();
  await driver.execute('CREATE TABLE sample(id)');
  assert.deepEqual(await driver.run('INSERT INTO sample VALUES (?)', [7]), { changes: 1, lastInsertId: 7 });
  await driver.commit();
  await driver.rollback();
  assert.deepEqual(calls, [
    ['create', 'test-only', false, 'no-encryption', 1, false], 'open', 'retrieve', 'begin',
    ['execute', 'CREATE TABLE sample(id)', false], ['run', 'INSERT INTO sample VALUES (?)', [7], false], 'commit', 'rollback',
  ]);
  assert.deepEqual(await driver.query('SELECT * FROM sample'), []);
  connection.query = async () => ({});
  await assert.rejects(driver.query('SELECT 1'), { code: 'INVALID_DATABASE_RESULT' });
  connection.run = async () => ({ changes: {} });
  await assert.rejects(driver.run('DELETE FROM sample'), { code: 'INVALID_DATABASE_RESULT' });
  await driver.close();
  await assert.rejects(driver.query('SELECT 1'), { code: 'DATABASE_NOT_OPEN' });
  await driver.open();
  assert.equal(calls.filter(item => item === 'open').length, 2);
});
