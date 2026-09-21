import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalId, parseDateOnly, toIsoDateTime } from '../src/shared/contracts/primitives.ts';
import { AppError } from '../src/shared/contracts/errors.ts';
import { ContractError } from '../src/shared/contracts/json/parse.ts';

test('本地主键只接受安全的正整数，不隐式转换云端字符串 ID', () => {
  assert.equal(parseLocalId(123), 123);
  for (const value of ['123', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => parseLocalId(value), { code: 'INVALID_LOCAL_ID' });
  }
});

test('日历日期严格验证闰年与格式，出生日期原样保留', () => {
  for (const value of ['2024-02-29', '2000-02-29', '2026-09-21', '0001-01-01', '9999-12-31']) {
    assert.equal(parseDateOnly(value), value);
  }
  for (const value of ['1900-02-29', '2026-02-29', '2026-04-31', '0000-01-01', '2026-00-01', '2026-13-01', '2026-01-00', '2026-9-21', '2026-09-21T00:00:00Z', null]) {
    assert.throws(() => parseDateOnly(value), { code: 'INVALID_DATE' });
  }
});

test('时间戳统一为 UTC，拒绝无效时间和超范围年份', () => {
  assert.equal(toIsoDateTime(new Date('2026-09-21T00:30:00+08:00')), '2026-09-20T16:30:00.000Z');
  for (const value of [new Date(NaN), new Date('0000-01-01'), new Date('+010000-01-01')]) {
    assert.throws(() => toIsoDateTime(value), { code: 'INVALID_TIMESTAMP' });
  }
});

test('JSON 校验错误沿用公共错误类型及稳定错误码', () => {
  const error = new ContractError('answers[0].score');
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'INVALID_JSON_CONTRACT');
});
