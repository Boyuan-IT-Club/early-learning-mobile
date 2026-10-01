import { useState } from 'react';
import type { FormEvent } from 'react';
import { BrandMark } from '../../../shared/ui/BrandMark.tsx';
import type { AuthService } from '../services/auth-service.ts';
import { Alert, AuthLayout, Field } from './AuthLayout.tsx';
import { describeError } from './messages.ts';
import s from './auth.module.css';

/**
 * 离线登录与本地解锁：只比对本机保存的密码哈希，不需要联网。
 * 连续输错 5 / 10 / 15 次分别锁 1 / 5 / 30 分钟，锁定落库，重启不清零。
 */
export function LoginPage({
  auth,
  username,
  lockedUntil,
  onLoggedIn,
  onRecover,
}: {
  auth: AuthService;
  username: string;
  lockedUntil: string | null;
  onLoggedIn: () => void;
  onRecover: () => void;
}) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await auth.login(password);
      onLoggedIn();
    } catch (error) {
      setFailure(describeError(error));
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout eyebrow="登录" title="欢迎回来" lead="输入本机密码进入工作台，无需联网。">
      <div className={s.account}>
        <BrandMark size="sm" />
        <span className={s.accountName}>{username}</span>
      </div>
      <form className={s.form} onSubmit={submit} noValidate>
        {lockedUntil && !failure && (
          <Alert tone="warn">连续输错次数过多，已暂时锁定到 {new Date(lockedUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}。</Alert>
        )}
        <Field label="本地密码" required>
          <input
            className={s.input}
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </Field>
        {failure && <Alert tone="danger">{failure}</Alert>}
        <div className={s.actions}>
          <button className={`${s.button} ${s.primary}`} disabled={!password || submitting}>
            {submitting ? '验证中…' : '登录'}
          </button>
          <button type="button" className={s.link} onClick={onRecover}>
            忘记密码？
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
