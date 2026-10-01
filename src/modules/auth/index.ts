export { AuthApi } from './api/auth-api.ts';
export { LocalAccountRepository } from './repositories/local-account-repository.ts';
export { AuthService } from './services/auth-service.ts';
export type { AuthServiceOptions } from './services/auth-service.ts';
export { ACTIVATION_CODE_LENGTH, normalizeActivationCode, normalizeUsername, USERNAME_PATTERN } from './credentials.ts';
export { checkPasswordPolicy, hashPassword, verifyPassword } from './password.ts';
export type { AuthRoute, CloudStatus, LocalAccount, LocalAccountId, RegisterInput, Session } from './types.ts';
export { AuthGate } from './ui/AuthGate.tsx';
export { AccountBanner } from './ui/AccountBanner.tsx';
