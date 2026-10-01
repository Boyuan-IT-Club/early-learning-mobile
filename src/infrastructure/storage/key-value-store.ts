/**
 * 非敏感的小型键值存储：WebView 的 localStorage（随应用私有数据保存，卸载即清除）。
 *
 * 只放非秘密的小数据：注册与刷新草稿的幂等键（输入只存哈希）、上次登录的用户名。
 * 不放密码、Token、激活码原文、儿童信息——业务数据的事实来源是 SQLite。
 */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function createLocalStorageStore(prefix = 'early-learning.'): KeyValueStore {
  return {
    get: key => globalThis.localStorage?.getItem(prefix + key) ?? null,
    set: (key, value) => globalThis.localStorage?.setItem(prefix + key, value),
    remove: key => globalThis.localStorage?.removeItem(prefix + key),
  };
}

/** 测试与非持久场景用。 */
export function createMemoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    remove: key => { values.delete(key); },
  };
}
