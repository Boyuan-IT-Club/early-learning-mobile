import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthService } from '../services/auth-service.ts';
import { Alert, AuthLayout, Field } from './AuthLayout.tsx';
import { describeError } from './messages.ts';
import s from './auth.module.css';

/**
 * 账号恢复：忘记本地密码、重装 App、换新设备时，凭管理员签发的恢复码找回（设计 D3）。
 * 恢复码 24 小时有效、一次性，输错 5 次作废。需要联网。
 */
export function RecoverPage({
  auth,
  knownUsername,
  onRecovered,
  onBack,
}: {
  auth: AuthService;
  /** 本机已有账号时固定为该用户名，不能恢复别人的账号。 */
  knownUsername: string | null;
  onRecovered: (result: { createdLocalAccount: boolean }) => void;
  onBack: () => void;
}) {
  const [username, setUsername] = useState(knownUsername ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const passwordError = password && (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
    ? '至少 8 位，并同时包含字母和数字'
    : null;
  const ready = username.trim() && code.replace(/[\s-]/g, '').length >= 8 && password && !passwordError
    && confirm === password;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const result = await auth.recover({ username, recoveryCode: code, newPassword: password });
      onRecovered(result);
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="账号恢复"
      title="用恢复码找回账号"
      lead="请先联系机构管理员签发恢复码。换新设备时，管理员需要先在后台解绑原设备。本步骤需要联网。"
    >
      <form className={s.form} onSubmit={submit} noValidate>
        <Field label="用户名" required>
          <input
            className={s.input}
            value={username}
            onChange={event => setUsername(event.target.value)}
            readOnly={knownUsername !== null}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
          />
        </Field>
        <Field label="恢复码" hint="8 位，形如 XXXX-XXXX" required>
          <input
            className={`${s.input} ${s.code}`}
            value={code}
            onChange={event => setCode(event.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </Field>
        <div className={s.grid2}>
          <Field label="新的本地密码" error={passwordError} required>
            <input
              className={s.input}
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="再输入一次" error={confirm && confirm !== password ? '两次输入不一致' : null} required>
            <input
              className={s.input}
              type="password"
              value={confirm}
              onChange={event => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
        {failure && <Alert tone="danger">{failure}</Alert>}
        <div className={s.actions}>
          <button className={`${s.button} ${s.primary}`} disabled={!ready || submitting}>
            {submitting ? '恢复中…' : '恢复账号'}
          </button>
          <button type="button" className={`${s.button} ${s.secondary}`} onClick={onBack} disabled={submitting}>
            返回
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
