import { HttpError } from '../../../infrastructure/http/index.ts';
import { AppError } from '../../../shared/contracts/index.ts';

/**
 * 错误码 → 教师能看懂的一句话。服务端文案偏技术，这里按平板上的场景改写；
 * 表里没有的码直接用错误自带的安全文案（AppError 约定 message 可展示）。
 */
const MESSAGES: Record<string, string> = {
  CLIENT_NETWORK_ERROR: '无法连接服务器。注册需要联网，请检查网络后重试。',
  CLIENT_TIMEOUT: '服务器响应超时，请稍后重试。',
  CLIENT_MALFORMED_RESPONSE: '服务器暂时无法正常响应，请稍后重试。',
  INVALID_REQUEST: '填写的内容格式不正确，请检查后重试。',
  LICENSE_UNAVAILABLE: '激活码不可用（不存在或已被使用）。请核对后重试，或向机构管理员确认。',
  LICENSE_REVOKED: '这个激活码已被撤销，请向机构管理员领取新的激活码。',
  USERNAME_EXISTS: '这个用户名已被占用，请换一个。',
  SENSITIVE_RESULT_EXPIRED: '账号可能已在云端创建，但本机没来得及保存凭证，无法再取回。请联系机构管理员处理。',
  RATE_LIMITED: '尝试过于频繁，请稍候 1 分钟再试。',
  DEPENDENCY_UNAVAILABLE: '服务器暂时不可用，请稍后重试。',
  INVALID_CLOUD_RESPONSE: '服务器返回的数据不完整，请稍后重试。',
};

export function describeError(error: unknown): string {
  if (error instanceof HttpError || error instanceof AppError) {
    return MESSAGES[error.code] ?? error.message;
  }
  return '操作没有完成，请重试。';
}
