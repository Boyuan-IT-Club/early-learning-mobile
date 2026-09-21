import { AppError } from './errors.ts';

declare const localId: unique symbol;
declare const dateOnly: unique symbol;
declare const isoDateTime: unique symbol;

/** 本地 SQLite 正整数主键；Kind 可用表名，不能用于云端 ID 或稳定 Code。 */
export type LocalId<Kind extends string> = number & { readonly [localId]: Kind };
export type DateOnly = string & { readonly [dateOnly]: true };
/** 新写入的时间戳使用 UTC ISO 8601，与 SQLite strftime 默认值一致。 */
export type IsoDateTime = string & { readonly [isoDateTime]: true };

export function parseLocalId<Kind extends string>(value: unknown): LocalId<Kind> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppError('INVALID_LOCAL_ID', '本地记录编号无效。');
  }
  return value as LocalId<Kind>;
}

/** 出生日期和评估日期不经过时区转换，拒绝不存在的日历日期。 */
export function parseDateOnly(value: unknown): DateOnly {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('INVALID_DATE', '日期须为有效的 YYYY-MM-DD。');
  }
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new AppError('INVALID_DATE', '日期须为有效的 YYYY-MM-DD。');
  }
  return value as DateOnly;
}

export function toIsoDateTime(value: Date): IsoDateTime {
  if (!Number.isFinite(value.getTime()) || value.getUTCFullYear() < 1 || value.getUTCFullYear() > 9999) {
    throw new AppError('INVALID_TIMESTAMP', '日期时间无效。');
  }
  return value.toISOString() as IsoDateTime;
}
