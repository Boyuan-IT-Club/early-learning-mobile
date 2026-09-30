import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Database } from '../src/infrastructure/database/database.ts';
import { initialMigration } from '../src/infrastructure/database/migrate.ts';
import { HttpClient, HttpError } from '../src/infrastructure/http/index.ts';
import { createMemoryStore } from '../src/infrastructure/storage/key-value-store.ts';
// 直接引用非 UI 源文件：模块入口还导出了 React 组件与 CSS Modules，Node 不能直接加载
import { AuthApi } from '../src/modules/auth/api/auth-api.ts';
import { verifyPassword } from '../src/modules/auth/password.ts';
import { LocalAccountRepository } from '../src/modules/auth/repositories/local-account-repository.ts';
import { AuthService } from '../src/modules/auth/services/auth-service.ts';

/**
 * 平板端账号与鉴权：真实 SQLite（Node 驱动）+ 脚本化的假服务端。
 * 编号对应 01_账号与鉴权 9.4 的验收用例。数据均为合成数据。
 */

const migrations = [
  initialMigration(readFileSync(new URL('../src/infrastructure/database/migrations/001_initial_sqlite.sql', import.meta.url), 'utf8')),
  { version: 2, sql: readFileSync(new URL('../src/infrastructure/database/migrations/002_auth.sql', import.meta.url), 'utf8') },
];

function databaseAt(path) {
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
  return new Database(driver, migrations);
}

/** 假服务端：按 "方法 路径" 分发；记录请求头与请求体。 */
function fakeServer() {
  const calls = [];
  const handlers = new Map();
  const on = (route, handler) => handlers.set(route, handler);
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const route = `${init.method} ${path}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, headers: init.headers, body });
    const handler = handlers.get(route);
    if (!handler) throw new TypeError('fetch failed'); // 等同断网
    const [status, payload] = await handler({ body, headers: init.headers, calls });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, on, fetchImpl };
}

const ok = data => ({ code: 'OK', message: '成功', data });
const fail = (code, message = '失败') => ({ code, message, data: null });
const session = (overrides = {}) => ok({
  user_id: 12, username: 'zhang_li', device_rebound: false,
  access_token: 'at_first', access_token_expires_at: '2026-09-30T10:00:00Z', refresh_token: 'rt_first',
  ...overrides,
});

let clock = new Date('2026-09-30T08:00:00.000Z');

async function fixture(t, { path, store = createMemoryStore(), server = fakeServer() } = {}) {
  let folder;
  if (!path) {
    folder = mkdtempSync(join(tmpdir(), 'early-learning-auth-test-'));
    path = join(folder, 'test.sqlite');
  }
  const database = databaseAt(path);
  await database.initialize();
  const http = new HttpClient('https://cloud.test', server.fetchImpl);
  const auth = new AuthService({
    database, repository: new LocalAccountRepository(), api: new AuthApi(http), store,
    now: () => clock, passwordIterations: 1_000,
  });
  http.useCredentials(auth);
  t.after(async () => {
    await database.close();
    if (folder) { rmSync(path, { force: true }); rmdirSync(folder); }
  });
  return { database, http, auth, server, store, path };
}

async function registered(t, options) {
  const env = await fixture(t, options);
  env.server.on('POST /api/auth/register', () => [201, session()]);
  await env.auth.register({ activationCode: '7K2Q-M9XD-4TPA-8H3N', username: 'zhang_li', password: 'abc12345' });
  return env;
}

async function localRow(database) {
  return database.read(reader => reader.query('SELECT * FROM user_local_account'));
}

test('迁移 002 只给 user_local_account 加列，版本升到 2', async t => {
  const { database } = await fixture(t);
  const columns = await database.read(reader => reader.query("SELECT name FROM pragma_table_info('user_local_account')"));
  const names = columns.map(row => row.name);
  for (const column of ['device_id', 'account_status', 'cloud_session', 'failed_login_count', 'locked_until', 'real_name']) {
    assert.ok(names.includes(column), column);
  }
});

test('注册：不上传密码；本地只存哈希；登录并进入资料页', async t => {
  const env = await registered(t);
  const register = env.server.calls.find(call => call.route === 'POST /api/auth/register');
  assert.deepEqual(Object.keys(register.body).sort(), ['activation_code', 'username']);
  assert.match(register.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.match(register.headers['X-Device-Id'], /^[0-9a-f-]{36}$/);

  const [row] = await localRow(env.database);
  assert.equal(row.username, 'zhang_li');
  assert.notEqual(row.password_hash, 'abc12345');
  assert.ok(await verifyPassword('abc12345', row.password_hash));
  assert.equal(row.access_token, 'at_first');
  assert.equal(row.device_id, register.headers['X-Device-Id']);
  assert.equal(env.auth.getSession()?.username, 'zhang_li');
  assert.deepEqual(await env.auth.route(), { kind: 'PROFILE' });
  assert.equal(env.store.get('register-draft'), null);
});

test('A5 注册断网后重试沿用同一个幂等键；换用户名换新键', async t => {
  const env = await fixture(t);
  const input = { activationCode: '7K2Q-M9XD-4TPA-8H3N', username: 'zhang_li', password: 'abc12345' };
  await assert.rejects(env.auth.register(input), error => error instanceof HttpError && error.offline);
  await assert.rejects(env.auth.register({ ...input, username: 'li_zhang' }), error => error.offline);
  await assert.rejects(env.auth.register(input), error => error.offline); // 又换回原用户名：新身份，新键
  env.server.on('POST /api/auth/register', () => [201, session()]);
  await env.auth.register(input);
  const keys = env.server.calls.filter(call => call.route === 'POST /api/auth/register').map(call => call.headers['Idempotency-Key']);
  assert.equal(keys.length, 4);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[2], keys[3]); // 断网重试沿用同一个键
});

test('A6 用户名已占用：丢弃草稿，下次换新键', async t => {
  const env = await fixture(t);
  env.server.on('POST /api/auth/register', () => [409, fail('USERNAME_EXISTS', '用户名已存在')]);
  const input = { activationCode: '7K2Q-M9XD-4TPA-8H3N', username: 'taken_name', password: 'abc12345' };
  await assert.rejects(env.auth.register(input), { code: 'USERNAME_EXISTS' });
  await assert.rejects(env.auth.register(input), { code: 'USERNAME_EXISTS' });
  const keys = env.server.calls.map(call => call.headers['Idempotency-Key']);
  assert.notEqual(keys[0], keys[1]);
  assert.equal((await localRow(env.database)).length, 0);
});

test('一台设备只能注册一个账号', async t => {
  const env = await registered(t);
  await assert.rejects(
    env.auth.register({ activationCode: 'AAAA-AAAA-AAAA-AAAA', username: 'other_one', password: 'abc12345' }),
    { code: 'DEVICE_HAS_ACCOUNT' },
  );
});

test('弱密码在联网前就被拒绝', async t => {
  const env = await fixture(t);
  await assert.rejects(env.auth.register({ activationCode: 'x', username: 'zhang_li', password: 'short' }), { code: 'WEAK_PASSWORD' });
  assert.equal(env.server.calls.length, 0);
});

test('A9 离线登录只比对本地密码，不访问云端', async t => {
  const env = await registered(t);
  env.auth.logout();
  const before = env.server.calls.length;
  await env.auth.login('abc12345');
  assert.equal(env.auth.getSession()?.username, 'zhang_li');
  assert.equal(env.server.calls.length, before);
});

test('A22 连续输错 5 次锁 1 分钟，重启后仍锁定', async t => {
  const env = await registered(t);
  env.auth.logout();
  for (let i = 0; i < 4; i++) await assert.rejects(env.auth.login('wrong-pass1'), { code: 'WRONG_PASSWORD' });
  await assert.rejects(env.auth.login('wrong-pass1'), error => error.code === 'WRONG_PASSWORD' && /锁定/.test(error.message));
  await env.database.close();

  const restarted = await fixture(t, { path: env.path, store: env.store });
  const route = await restarted.auth.route();
  assert.equal(route.kind, 'LOGIN');
  assert.ok(route.lockedUntil);
  await assert.rejects(restarted.auth.login('abc12345'), { code: 'LOGIN_LOCKED' });

  clock = new Date(clock.getTime() + 61_000);
  await restarted.auth.login('abc12345');
  const [row] = await localRow(restarted.database);
  assert.equal(row.failed_login_count, 0);
});

test('A21 退出不删本地数据；后台超时需要解锁', async t => {
  const env = await registered(t);
  env.auth.markBackground();
  clock = new Date(clock.getTime() + 16 * 60_000);
  env.auth.markForeground();
  assert.equal(env.auth.getSession(), null);
  assert.equal((await localRow(env.database)).length, 1);
  assert.equal((await env.auth.route()).kind, 'LOGIN');
});

test('A10 并发 5 个请求都遇到 401 过期，只刷新一次，全部重试成功', async t => {
  const env = await registered(t);
  let refreshes = 0;
  env.server.on('POST /api/auth/refresh', async ({ body }) => {
    refreshes += 1;
    assert.equal(body.refresh_token, 'rt_first');
    await new Promise(resolve => setTimeout(resolve, 20));
    return [200, ok({ access_token: 'at_second', access_token_expires_at: 'x', refresh_token: 'rt_second' })];
  });
  env.server.on('GET /api/ai/rubrics', ({ headers }) => headers.Authorization === 'Bearer at_second'
    ? [200, ok({ items: [] })]
    : [401, fail('TOKEN_EXPIRED', '凭证已过期')]);

  const results = await Promise.all(Array.from({ length: 5 }, () => env.http.get('/api/ai/rubrics')));
  assert.equal(results.length, 5);
  assert.equal(refreshes, 1);
  const [row] = await localRow(env.database);
  assert.equal(row.refresh_token, 'rt_second');
});

test('A13 A14 A15 停用信号落库：受限模式，重启后仍受限；云端恢复后自动解除', async t => {
  const env = await registered(t);
  env.server.on('GET /api/auth/me', () => [403, fail('ACCOUNT_DISABLED', '账号不可用')]);
  await env.auth.syncStatus();
  assert.equal(env.auth.getSession()?.accountStatus, 'DISABLED');
  assert.throws(() => env.auth.requireWritable(), { code: 'AUTH_ACCOUNT_RESTRICTED' });
  await env.database.close();

  const restarted = await fixture(t, { path: env.path, store: env.store, server: env.server });
  await restarted.auth.login('abc12345'); // 受限模式下仍允许登录
  assert.equal(restarted.auth.getSession()?.accountStatus, 'DISABLED');
  assert.throws(() => restarted.auth.requireWritable(), { code: 'AUTH_ACCOUNT_RESTRICTED' });

  env.server.on('GET /api/auth/me', () => [200, ok({ user_id: 12, username: 'zhang_li', account_status: 'ACTIVE' })]);
  await restarted.auth.syncStatus();
  assert.equal(restarted.auth.requireWritable().accountStatus, 'ACTIVE');
});

test('A17 解绑（DEVICE_MISMATCH）不会被后续成功请求自动解除', async t => {
  const env = await registered(t);
  env.server.on('GET /api/auth/me', () => [403, fail('DEVICE_MISMATCH', '设备不一致')]);
  await env.auth.syncStatus();
  await env.auth.accountSignal('OK');
  assert.equal(env.auth.getSession()?.accountStatus, 'UNBOUND');
});

test('刷新凭证失效：标记云端会话丢失，本地业务不受影响', async t => {
  const env = await registered(t);
  env.server.on('POST /api/auth/refresh', () => [401, fail('REFRESH_TOKEN_INVALID', '刷新凭证无效')]);
  env.server.on('GET /api/auth/me', () => [401, fail('TOKEN_EXPIRED', '凭证已过期')]);
  await env.auth.syncStatus();
  const session = env.auth.getSession();
  assert.equal(session?.cloudSession, 'LOST');
  assert.equal(session?.accountStatus, 'ACTIVE');
  assert.equal(env.auth.requireWritable().username, 'zhang_li');
});

test('A19 同设备凭恢复码重设密码，本地数据保留', async t => {
  const env = await registered(t);
  env.auth.logout();
  env.server.on('POST /api/auth/recover', ({ body }) => {
    assert.deepEqual(body, { username: 'zhang_li', recovery_code: 'Q4ZM-7TK2' });
    return [200, session({ access_token: 'at_recovered', refresh_token: 'rt_recovered' })];
  });
  const result = await env.auth.recover({ username: 'zhang_li', recoveryCode: 'Q4ZM-7TK2', newPassword: 'newpass99' });
  assert.equal(result.createdLocalAccount, false);
  const rows = await localRow(env.database);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].access_token, 'at_recovered');
  env.auth.logout();
  await assert.rejects(env.auth.login('abc12345'), { code: 'WRONG_PASSWORD' });
  await env.auth.login('newpass99');
});

test('A18 新设备（无本地账号）凭恢复码建立本地账号', async t => {
  const env = await fixture(t);
  env.server.on('POST /api/auth/recover', () => [200, session({ device_rebound: true })]);
  const result = await env.auth.recover({ username: 'zhang_li', recoveryCode: 'Q4ZM-7TK2', newPassword: 'newpass99' });
  assert.deepEqual(result, { deviceRebound: true, createdLocalAccount: true });
  assert.equal((await localRow(env.database))[0].username, 'zhang_li');
});

test('本设备已有其他账号时不能恢复别人的账号', async t => {
  const env = await registered(t);
  await assert.rejects(
    env.auth.recover({ username: 'someone_else', recoveryCode: 'Q4ZM-7TK2', newPassword: 'newpass99' }),
    { code: 'DEVICE_HAS_ACCOUNT' },
  );
});

test('教师资料：姓名与专业背景必填，只存本地，补全后进入首页', async t => {
  const env = await registered(t);
  const empty = { realName: '', professionalBackground: null, jobTitle: null, organization: null, yearsOfExperience: null, workExperience: null, teachingExpertise: null };
  await assert.rejects(env.auth.saveProfile(empty), { code: 'PROFILE_INCOMPLETE' });
  const before = env.server.calls.length;
  await env.auth.saveProfile({ ...empty, realName: '张丽', professionalBackground: '特殊教育', yearsOfExperience: 3 });
  assert.equal(env.server.calls.length, before);
  assert.deepEqual(await env.auth.route(), { kind: 'HOME' });
  assert.equal((await env.auth.profile()).realName, '张丽');
});
