import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthService } from '../services/auth-service.ts';
import { Alert, AuthLayout, Field } from './AuthLayout.tsx';
import { describeError } from './messages.ts';
import s from './auth.module.css';

/** 离线登录：用户名 + 本地密码，只比对本机保存的密码哈希，不需要联网。 */
export function LoginPage({
  auth,
  lastUsername,
  onLoggedIn,
  onRegister,
}: {
  auth: AuthService;
  lastUsername: string | null;
  onLoggedIn: () => void;
  onRegister: () => void;
}) {
  const [username, setUsername] = useState(lastUsername ?? '');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = username.trim() !== '' && password !== '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await auth.login(username, password);
      onLoggedIn();
    } catch (error) {
      setFailure(describeError(error));
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout eyebrow="登录" title="欢迎回来" lead="输入用户名与本机密码进入工作台，无需联网。">
      <form className={s.form} onSubmit={submit} noValidate>
        <Field label="用户名" required>
          <input
            className={s.input}
            value={username}
            onChange={event => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus={!lastUsername}
          />
        </Field>
        <Field label="本地密码" required>
          <input
            className={s.input}
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus={Boolean(lastUsername)}
          />
        </Field>
        {failure && <Alert tone="danger">{failure}</Alert>}
        <div className={s.actions}>
          <button className={`${s.button} ${s.primary}`} disabled={!ready || submitting}>
            {submitting ? '验证中…' : '登录'}
          </button>
          <button type="button" className={s.link} onClick={onRegister}>
            用新的激活码注册账号
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
