import { AppError } from '../../shared/contracts/index.ts';

/**
 * 注册输入的规范化，与服务端约定一致（01_账号与鉴权 v0.3 第 4.4 节）。
 *
 * 服务端按原样核对激活码、不做任何规范化，所以由平板负责把手抄、手输的变体还原成发放时的样子。
 */

/** 契约 `Username`：3—64 位 ASCII 字母、数字、下划线、点或连字符；服务端转小写后唯一。 */
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;

/** 激活码：16 位 Crockford Base32（0-9 与去掉 I、L、O、U 的大写字母）。 */
export const ACTIVATION_CODE_LENGTH = 16;
const ACTIVATION_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;

export function normalizeUsername(raw: string): string {
  const value = raw.trim();
  if (!USERNAME_PATTERN.test(value)) {
    throw new AppError('INVALID_USERNAME', '用户名需 3–64 位字母、数字、下划线、点或连字符。');
  }
  return value.toLowerCase();
}

/**
 * 去掉空白与连字符、转大写，并按 Crockford 规则把易混字符还原：O→0，I、L→1。
 * 结果不是 16 位合法字符时报错，不发请求。
 */
export function normalizeActivationCode(raw: string): string {
  const value = raw.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!ACTIVATION_CODE_PATTERN.test(value)) {
    throw new AppError('INVALID_ACTIVATION_CODE', '激活码应为 16 位字母或数字，请对照纸条重新输入。');
  }
  return value;
}
