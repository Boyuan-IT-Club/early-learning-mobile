import { HttpError } from '../../../infrastructure/http/index.ts';
import { AppError } from '../../../shared/contracts/index.ts';

/**
 * 错误码 → 教师能看懂的一句话。服务端文案偏技术，这里按平板上的场景改写；
 * 表里没有的码直接用错误自带的安全文案（AppError 约定 message 可展示）。
 */
const MESSAGES: Record<string, string> = {
  CLIENT_NETWORK_ERROR: '无法连接服务器。注册与账号恢复需要联网，请检查网络后重试。',
  CLIENT_TIMEOUT: '服务器响应超时，请稍后重试。',
  CLIENT_MALFORMED_RESPONSE: '服务器暂时无法正常响应，请稍后重试。',
  INVALID_REQUEST: '填写的内容格式不正确，请检查后重试。',
  LICENSE_UNAVAILABLE: '激活码不可用（不存在、已被使用或已撤销）。请向机构管理员确认。',
  USERNAME_EXISTS: '这个用户名已被占用，请换一个。',
  DEVICE_ALREADY_BOUND: '账号或本设备已与其他绑定关系冲突。换设备时，请先请管理员在后台解绑原设备。',
  SENSITIVE_RESULT_EXPIRED: '账号已在云端创建，但本机没来得及保存凭证。请联系管理员签发恢复码，在「账号恢复」中找回。',
  RECOVERY_CODE_INVALID: '用户名或恢复码不正确，或恢复码已过期、已使用。连续输错 5 次恢复码会作废。',
  ACCOUNT_DISABLED: '该账号已被机构停用，请联系管理员。',
  LICENSE_REVOKED: '该账号的激活码已被撤销，请联系管理员。',
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
