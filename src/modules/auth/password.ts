import { AppError } from '../../shared/contracts/index.ts';

/**
 * 教师本地密码的哈希：PBKDF2-HMAC-SHA256，16 字节随机盐。
 *
 * 用 WebCrypto（Android WebView 与 Node 都自带），不引入原生依赖。
 * 存储格式 `pbkdf2_sha256$<迭代次数>$<盐 Base64>$<哈希 Base64>`：迭代次数随哈希保存，
 * 以后调整次数不影响旧密码校验。云端从不接收这个哈希（设计 C3、D6）。
 */

/** 默认 600,000 次；若目标设备上一次计算超过 1 秒，可在组装处降到 310,000（设计 2.2）。 */
export const DEFAULT_ITERATIONS = 600_000;

const PREFIX = 'pbkdf2_sha256';

/** 与设计 6.8 一致：至少 8 位，同时包含字母和数字。 */
export function checkPasswordPolicy(password: string): void {
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new AppError('WEAK_PASSWORD', '密码至少 8 位，并同时包含字母和数字。');
  }
}

export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `${PREFIX}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
  const expected = fromBase64(parts[3]);
  const actual = await derive(password, fromBase64(parts[2]), iterations);
  return constantTimeEqual(actual, expected);
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
