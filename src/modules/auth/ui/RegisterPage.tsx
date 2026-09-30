import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthService } from '../services/auth-service.ts';
import { Alert, AuthLayout, Field } from './AuthLayout.tsx';
import { describeError } from './messages.ts';
import s from './auth.module.css';

const USERNAME = /^[A-Za-z0-9_.-]{4,32}$/;

/**
 * 第二步：设置用户名与本地密码。密码只保存在这台平板上（云端从不接收），日常登录不需要联网。
 */
export function RegisterPage({
  auth,
  activationCode,
  onBack,
  onRegistered,
  onRecover,
}: {
  auth: AuthService;
  activationCode: string;
  onBack: () => void;
  onRegistered: () => void;
  onRecover: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ text: string; code: string } | null>(null);

  const usernameError = username && !USERNAME.test(username) ? '4–32 位字母、数字、下划线、点或连字符' : null;
  const passwordError = password && (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
    ? '至少 8 位，并同时包含字母和数字'
    : null;
  const confirmError = confirm && confirm !== password ? '两次输入不一致' : null;
  const ready = USERNAME.test(username) && password && !passwordError && confirm === password;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await auth.register({ activationCode, username, password });
      onRegistered();
    } catch (error) {
      setFailure({ text: describeError(error), code: (error as { code?: string }).code ?? '' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="注册"
      title="设置账号"
      lead="用户名用于在云端识别你；密码只保存在这台平板上，用于每天离线登录。"
    >
      <form className={s.form} onSubmit={submit} noValidate>
        <Field label="用户名" hint="区分大小写，注册后不能修改" error={usernameError} required>
          <input
            className={s.input}
            value={username}
            onChange={event => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
          />
        </Field>
        <Field label="本地密码" hint="至少 8 位，同时包含字母和数字" error={passwordError} required>
          <input
            className={s.input}
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="再输入一次" error={confirmError} required>
          <input
            className={s.input}
            type="password"
            value={confirm}
            onChange={event => setConfirm(event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        {failure && (
          <Alert tone="danger">
            {failure.text}
            {failure.code === 'SENSITIVE_RESULT_EXPIRED' && (
              <> <button type="button" className={s.link} onClick={onRecover}>去账号恢复</button></>
            )}
          </Alert>
        )}
        <div className={s.actions}>
          <button className={`${s.button} ${s.primary}`} disabled={!ready || submitting}>
            {submitting ? '注册中…' : failure ? '重试注册' : '完成注册'}
          </button>
          <button type="button" className={`${s.button} ${s.secondary}`} onClick={onBack} disabled={submitting}>
            返回修改激活码
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
