export { AuthApi } from './api/auth-api.ts';
export { LocalAccountRepository } from './repositories/local-account-repository.ts';
export { AuthService, isProfileComplete } from './services/auth-service.ts';
export type { AuthServiceOptions } from './services/auth-service.ts';
export { checkPasswordPolicy, hashPassword, verifyPassword } from './password.ts';
export type {
  AccountStatus, AuthRoute, CloudSession, LocalAccount, LocalAccountId, RecoverInput, RegisterInput, Session,
  TeacherProfile,
} from './types.ts';
export { AuthGate } from './ui/AuthGate.tsx';
export { AccountBanner } from './ui/AccountBanner.tsx';
