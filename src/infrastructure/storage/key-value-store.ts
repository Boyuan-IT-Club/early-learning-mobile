/**
 * 非敏感的小型键值存储：WebView 的 localStorage（随应用私有数据保存，卸载即清除）。
 *
 * 只放"还没有本地账号时就要用到"的非秘密数据：设备号、注册草稿的幂等键。
 * 不放密码、Token、儿童信息——业务数据的事实来源是 SQLite。
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
