import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
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
import { normalizeActivationCode } from '../src/modules/auth/credentials.ts';
import { verifyPassword } from '../src/modules/auth/password.ts';
import { LocalAccountRepository } from '../src/modules/auth/repositories/local-account-repository.ts';
import { AuthService } from '../src/modules/auth/services/auth-service.ts';

/**
 * 平板端账号与鉴权（契约 registerTeacher、refreshTeacherToken）：真实 SQLite（Node 驱动）+ 脚本化的假服务端。
 * 数据均为合成数据。
 */

const migrations = [
  initialMigration(readFileSync(new URL('../src/infrastructure/database/migrations/001_initial_sqlite.sql', import.meta.url), 'utf8')),
];

const CODE = '7K2QM9XD4TPA8H3N';
const PASSWORD = 'abc12345';
const TASK = '/api/ai/tasks/33333333-3333-3333-3333-333333333333';

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

/** 假服务端：按 "方法 路径" 分发；记录请求头与请求体。没有对应处理器即等同断网。 */
function fakeServer() {
  const calls = [];
  const handlers = new Map();
  const on = (route, handler) => handlers.set(route, handler);
  const off = route => handlers.delete(route);
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const route = `${init.method} ${path}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, headers: init.headers, body });
    const handler = handlers.get(route);
    if (!handler) throw new TypeError('fetch failed');
    const [status, payload] = await handler({ body, headers: init.headers, calls });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, on, off, fetchImpl };
}

const ok = data => ({ code: 'OK', message: '成功', data });
const fail = (code, message = '失败') => ({ code, message, data: null });
/** 契约 TokenPair。 */
const pair = (n = 1, username = 'zhang_li', id = 12) => ok({
  access_token: `at_${n}`,
  refresh_token: `rt_${n}`,
  token_type: 'Bearer',
  access_expires_at: '2026-09-30T10:00:00.000Z',
  user: { id, username, status: 1, created_at: '2026-09-30T08:00:00.000Z' },
});

let clock = new Date('2026-09-30T08:00:00.000Z');

async function fixture(t, { store = createMemoryStore(), server = fakeServer() } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'early-learning-auth-test-'));
  const path = join(folder, 'test.sqlite');
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
    for (const file of readdirSync(folder)) rmSync(join(folder, file), { force: true });
    rmdirSync(folder);
  });
  return { database, http, auth, server, store };
}

async function registered(t, options) {
  const env = await fixture(t, options);
  env.server.on('POST /api/auth/register', () => [201, pair(1)]);
  await env.auth.register({ activationCode: CODE, username: 'Zhang_Li', password: PASSWORD });
  return env;
}

async function localRows(database) {
  return database.read(reader => reader.query('SELECT * FROM user_local_account ORDER BY id'));
}

const routeCalls = (server, route) => server.calls.filter(call => call.route === route);

// ---------------------------------------------------------------- 数据库

test('只用 001 迁移：user_local_account 仍是原来的 5 列', async t => {
  const { database } = await fixture(t);
  const columns = await database.read(reader => reader.query("SELECT name FROM pragma_table_info('user_local_account')"));
  assert.deepEqual(columns.map(row => row.name), ['id', 'username', 'password_hash', 'access_token', 'refresh_token']);
  const [{ user_version: version }] = await database.read(reader => reader.query('SELECT user_version FROM pragma_user_version'));
  assert.equal(version, 1);
});

// ---------------------------------------------------------------- 注册

test('注册：只上传激活码与用户名并带幂等键；本地只存哈希与两枚 Token；直接进入工作台', async t => {
  const env = await registered(t);
  const [register] = routeCalls(env.server, 'POST /api/auth/register');
  assert.deepEqual(register.body, { activation_code: CODE, username: 'zhang_li' });
  assert.match(register.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(register.headers['X-Device-Id'], undefined);
  assert.equal(register.headers.Authorization, undefined);

  const [row] = await localRows(env.database);
  assert.equal(row.username, 'zhang_li');
  assert.notEqual(row.password_hash, PASSWORD);
  assert.ok(await verifyPassword(PASSWORD, row.password_hash));
  assert.equal(row.access_token, 'at_1');
  assert.equal(row.refresh_token, 'rt_1');
  assert.deepEqual(env.auth.getSession(), { teacherId: row.id, username: 'zhang_li', cloud: 'OK' });
  assert.deepEqual(await env.auth.route(), { kind: 'HOME' });
  assert.equal(env.store.get('register-draft'), null);
});

test('激活码由平板规范化：去空格与连字符、转大写、O→0、I/L→1', () => {
  assert.equal(normalizeActivationCode(' 7k2q-m9xd 4tpa-8h3n '), CODE);
  assert.equal(normalizeActivationCode('OIL0-0000-0000-0000'), '0110000000000000');
  assert.throws(() => normalizeActivationCode('7K2Q-M9XD-4TPA'), { code: 'INVALID_ACTIVATION_CODE' });
  assert.throws(() => normalizeActivationCode('7K2Q-M9XD-4TPA-8H3U'), { code: 'INVALID_ACTIVATION_CODE' });
});

test('输入不合法在联网前就被拒绝', async t => {
  const env = await fixture(t);
  await assert.rejects(env.auth.register({ activationCode: CODE, username: 'zhang_li', password: 'short' }),
    { code: 'WEAK_PASSWORD' });
  await assert.rejects(env.auth.register({ activationCode: CODE, username: 'ab', password: PASSWORD }),
    { code: 'INVALID_USERNAME' });
  await assert.rejects(env.auth.register({ activationCode: '123', username: 'zhang_li', password: PASSWORD }),
    { code: 'INVALID_ACTIVATION_CODE' });
  assert.equal(env.server.calls.length, 0);
});

test('注册断网后原样重试沿用同一个幂等键；改了用户名换新键；草稿不含激活码原文', async t => {
  const env = await fixture(t);
  const input = { activationCode: CODE, username: 'zhang_li', password: PASSWORD };
  await assert.rejects(env.auth.register(input), error => error instanceof HttpError && error.offline);
  assert.ok(!env.store.get('register-draft').includes(CODE));
  await assert.rejects(env.auth.register({ ...input, activationCode: '7k2q-m9xd-4tpa-8h3n' }), error => error.offline);
  await assert.rejects(env.auth.register({ ...input, username: 'li_zhang' }), error => error.offline);
  env.server.on('POST /api/auth/register', () => [201, pair(1, 'li_zhang')]);
  await env.auth.register({ ...input, username: 'li_zhang' });

  const keys = routeCalls(env.server, 'POST /api/auth/register').map(call => call.headers['Idempotency-Key']);
  assert.equal(keys[0], keys[1], '规范化后相同的激活码是同一次注册');
  assert.notEqual(keys[1], keys[2]);
  assert.equal(keys[2], keys[3]);
});

test('业务失败（用户名已占用）丢弃草稿，下次换新键；本地不留账号', async t => {
  const env = await fixture(t);
  env.server.on('POST /api/auth/register', () => [409, fail('USERNAME_EXISTS', '用户名已存在')]);
  const input = { activationCode: CODE, username: 'taken_name', password: PASSWORD };
  await assert.rejects(env.auth.register(input), { code: 'USERNAME_EXISTS' });
  await assert.rejects(env.auth.register(input), { code: 'USERNAME_EXISTS' });
  const keys = env.server.calls.map(call => call.headers['Idempotency-Key']);
  assert.notEqual(keys[0], keys[1]);
  assert.equal((await localRows(env.database)).length, 0);
});

test('同一台平板可以再注册新账号（旧账号云端失效后用新激活码），但不能重复同名', async t => {
  const env = await registered(t);
  env.auth.logout();
  await assert.rejects(env.auth.register({ activationCode: CODE, username: 'ZHANG_LI', password: PASSWORD }),
    { code: 'LOCAL_USERNAME_EXISTS' });

  env.server.on('POST /api/auth/register', () => [201, pair(2, 'wang_fang', 13)]);
  await env.auth.register({ activationCode: 'AAAAAAAAAAAAAAAA', username: 'wang_fang', password: PASSWORD });
  assert.deepEqual((await localRows(env.database)).map(row => row.username), ['zhang_li', 'wang_fang']);
  assert.equal(env.auth.getSession().username, 'wang_fang');
});

// ---------------------------------------------------------------- 登录

test('离线登录：用户名不区分大小写；用户名不存在与密码错误给同一句提示', async t => {
  const env = await registered(t);
  env.auth.logout();
  env.server.calls.length = 0;
  assert.deepEqual(await env.auth.route(), { kind: 'LOGIN', lastUsername: 'zhang_li' });

  await assert.rejects(env.auth.login('zhang_li', 'wrong123'), { code: 'WRONG_CREDENTIALS' });
  await assert.rejects(env.auth.login('nobody', PASSWORD), { code: 'WRONG_CREDENTIALS' });
  await env.auth.login(' ZHANG_LI ', PASSWORD);
  assert.equal(env.auth.getSession().username, 'zhang_li');
  assert.equal(env.server.calls.length, 0, '登录不联网');
});

test('退出只清会话、不删 Token；后台超过 15 分钟回到登录页', async t => {
  const env = await registered(t);
  env.auth.logout();
  assert.equal(env.auth.getSession(), null);
  assert.equal((await localRows(env.database))[0].access_token, 'at_1');

  await env.auth.login('zhang_li', PASSWORD);
  env.auth.markBackground();
  clock = new Date(clock.getTime() + 15 * 60_000);
  env.auth.markForeground();
  assert.equal(env.auth.getSession(), null);
});

// ---------------------------------------------------------------- 刷新

test('access 过期：刷新一次（带幂等键），两枚新 Token 一起保存，原请求用新 Token 重试', async t => {
  const env = await registered(t);
  env.server.on('GET ' + TASK, ({ headers }) =>
    headers.Authorization === 'Bearer at_2' ? [200, ok({ task_id: 'x' })] : [401, fail('TOKEN_EXPIRED')]);
  env.server.on('POST /api/auth/refresh', () => [200, pair(2)]);

  assert.deepEqual(await env.http.get(TASK), { task_id: 'x' });

  const [refresh] = routeCalls(env.server, 'POST /api/auth/refresh');
  assert.deepEqual(refresh.body, { refresh_token: 'rt_1' });
  assert.match(refresh.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(refresh.headers.Authorization, undefined);
  const [row] = await localRows(env.database);
  assert.equal(row.access_token, 'at_2');
  assert.equal(row.refresh_token, 'rt_2');
  assert.equal(env.store.get('refresh-draft:' + row.id), null);
});

test('并发请求同时遇到过期：只刷新一次', async t => {
  const env = await registered(t);
  env.server.on('GET ' + TASK, ({ headers }) =>
    headers.Authorization === 'Bearer at_2' ? [200, ok({})] : [401, fail('TOKEN_EXPIRED')]);
  env.server.on('POST /api/auth/refresh', async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return [200, pair(2)];
  });
  await Promise.all([env.http.get(TASK), env.http.get(TASK), env.http.get(TASK)]);
  assert.equal(routeCalls(env.server, 'POST /api/auth/refresh').length, 1);
});

test('刷新断网：原请求报错；之后再刷新沿用同一个幂等键，草稿不含 refresh_token 原文', async t => {
  const env = await registered(t);
  env.server.on('GET ' + TASK, ({ headers }) =>
    headers.Authorization === 'Bearer at_2' ? [200, ok({})] : [401, fail('TOKEN_EXPIRED')]);
  await assert.rejects(env.http.get(TASK), { code: 'TOKEN_EXPIRED' });
  const [row] = await localRows(env.database);
  assert.ok(!env.store.get('refresh-draft:' + row.id).includes('rt_1'));

  env.server.on('POST /api/auth/refresh', () => [200, pair(2)]);
  await env.http.get(TASK);
  const keys = routeCalls(env.server, 'POST /api/auth/refresh').map(call => call.headers['Idempotency-Key']);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test('同键重放已过期（SENSITIVE_RESULT_EXPIRED）：换新键再试一次，在宽限内取回新凭证', async t => {
  const env = await registered(t);
  env.server.on('GET ' + TASK, ({ headers }) =>
    headers.Authorization === 'Bearer at_2' ? [200, ok({})] : [401, fail('TOKEN_EXPIRED')]);
  let attempts = 0;
  env.server.on('POST /api/auth/refresh', () => {
    attempts += 1;
    return attempts === 1 ? [409, fail('SENSITIVE_RESULT_EXPIRED')] : [200, pair(2)];
  });
  await env.http.get(TASK);
  const keys = routeCalls(env.server, 'POST /api/auth/refresh').map(call => call.headers['Idempotency-Key']);
  assert.notEqual(keys[0], keys[1]);
  assert.equal((await localRows(env.database))[0].refresh_token, 'rt_2');
});

test('refresh_token 失效：清掉本地 Token，提示云端凭证失效；本地登录照常', async t => {
  const env = await registered(t);
  env.server.on('GET ' + TASK, () => [401, fail('TOKEN_EXPIRED')]);
  env.server.on('POST /api/auth/refresh', () => [401, fail('REFRESH_TOKEN_INVALID')]);

  await assert.rejects(env.http.get(TASK), { code: 'TOKEN_EXPIRED' });
  const [row] = await localRows(env.database);
  assert.equal(row.access_token, null);
  assert.equal(row.refresh_token, null);
  assert.equal(env.auth.getSession().cloud, 'LOST');

  // 重启后（重新登录）仍然是 LOST，且不再尝试刷新
  env.auth.logout();
  await env.auth.login('zhang_li', PASSWORD);
  assert.equal(env.auth.getSession().cloud, 'LOST');
  const before = routeCalls(env.server, 'POST /api/auth/refresh').length;
  await assert.rejects(env.http.get(TASK));
  assert.equal(routeCalls(env.server, 'POST /api/auth/refresh').length, before);
});

test('云端停用（403）只提示，不结束本地会话；之后请求成功即恢复', async t => {
  const env = await registered(t);
  let disabled = true;
  env.server.on('GET ' + TASK, () => disabled ? [403, fail('ACCOUNT_DISABLED')] : [200, ok({})]);

  await assert.rejects(env.http.get(TASK), { code: 'ACCOUNT_DISABLED' });
  assert.equal(env.auth.getSession().cloud, 'DISABLED');
  assert.equal(env.auth.getSession().username, 'zhang_li');

  disabled = false;
  await env.http.get(TASK);
  assert.equal(env.auth.getSession().cloud, 'OK');
});

test('刷新时激活码已撤销（403）：提示撤销，保留 Token', async t => {
  const env = await registered(t);
  env.server.on('GET ' + TASK, () => [401, fail('TOKEN_EXPIRED')]);
  env.server.on('POST /api/auth/refresh', () => [403, fail('LICENSE_REVOKED')]);

  await assert.rejects(env.http.get(TASK), { code: 'TOKEN_EXPIRED' });
  assert.equal(env.auth.getSession().cloud, 'REVOKED');
  assert.equal((await localRows(env.database))[0].refresh_token, 'rt_1');
});

test('会话变化通知监听者', async t => {
  const env = await fixture(t);
  const seen = [];
  env.auth.onSessionChange(session => seen.push(session?.cloud ?? null));
  env.server.on('POST /api/auth/register', () => [201, pair(1)]);
  await env.auth.register({ activationCode: CODE, username: 'zhang_li', password: PASSWORD });
  await env.auth.accountSignal('ACCOUNT_DISABLED');
  env.auth.logout();
  assert.deepEqual(seen, ['OK', 'DISABLED', null]);
});
