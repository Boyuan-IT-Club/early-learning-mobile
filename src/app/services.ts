import type { Database } from '../infrastructure/database/index.ts';
import { HttpClient } from '../infrastructure/http/index.ts';
import { createLocalStorageStore } from '../infrastructure/storage/key-value-store.ts';
import { AuthApi, AuthService, LocalAccountRepository } from '../modules/auth/index.ts';

/**
 * 唯一的服务组装点：HTTP 客户端与账号服务。数据库就绪后调用一次。
 *
 * 云端地址来自构建时变量 `VITE_API_BASE_URL`（例如 https://api.example.edu）；未配置时所有联网操作
 * 报"无法连接服务器"，离线登录与本地业务不受影响。
 */
export interface AppServices {
  http: HttpClient;
  auth: AuthService;
}

let services: AppServices | undefined;

export function getServices(database: Database): AppServices {
  if (services) return services;
  const http = new HttpClient(import.meta.env.VITE_API_BASE_URL ?? '');
  const auth = new AuthService({
    database,
    repository: new LocalAccountRepository(),
    api: new AuthApi(http),
    store: createLocalStorageStore(),
  });
  http.useCredentials(auth);
  services = { http, auth };
  return services;
}
