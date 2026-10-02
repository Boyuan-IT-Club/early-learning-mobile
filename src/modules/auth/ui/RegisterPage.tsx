import { useState } from 'react';
import type { FormEvent } from 'react';
import { ACTIVATION_CODE_LENGTH, USERNAME_PATTERN } from '../credentials.ts';
import type { AuthService } from '../services/auth-service.ts';
import { Alert, AuthLayout, Field } from './AuthLayout.tsx';
import { describeError } from './messages.ts';
import s from './auth.module.css';

const PASSWORD_RULE = '至少 8 位，并同时包含字母和数字';

function passwordOk(password: string): boolean {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

/**
 * 一步注册：激活码、用户名、本地密码一起填（契约没有单独校验激活码的接口，提交时才知道码是否可用）。
 * 需要联网。密码只保存在这台平板上，云端从不接收；日常登录不需要联网。
 */
export function RegisterPage({
  auth,
  onRegistered,
  onBack,
}: {
  auth: AuthService;
  onRegistered: () => void;
  /** 本机已有账号时可以返回登录。 */
  onBack?: () => void;
}) {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const codeFilled = code.replace(/[\s-]/g, '').length === ACTIVATION_CODE_LENGTH;
  const usernameError = username && !USERNAME_PATTERN.test(username.trim())
    ? '3–64 位字母、数字、下划线、点或连字符' : null;
  const passwordError = password && !passwordOk(password) ? PASSWORD_RULE : null;
  const confirmError = confirm && confirm !== password ? '两次输入不一致' : null;
  const ready = codeFilled && USERNAME_PATTERN.test(username.trim()) && passwordOk(password) && confirm === password;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await auth.register({ activationCode: code, username, password });
      onRegistered();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="注册"
      title="激活并创建账号"
      lead="激活码由机构管理员发放，一个激活码只能注册一个账号。注册需要联网；之后每天离线登录即可。"
    >
      <form className={s.form} onSubmit={submit} noValidate>
        <Field label="激活码" hint="16 位，大小写、空格与连字符都可以" required>
          <input
            className={`${s.input} ${s.code}`}
            value={code}
            onChange={event => setCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </Field>
        <Field label="用户名" hint="不区分大小写，注册后不能修改" error={usernameError} required>
          <input
            className={s.input}
            value={username}
            onChange={event => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
          />
        </Field>
        <Field label="本地密码" hint={`${PASSWORD_RULE}；只保存在这台平板上`} error={passwordError} required>
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
        {failure && <Alert tone="danger">{failure}</Alert>}
        <div className={s.actions}>
          <button className={`${s.button} ${s.primary}`} disabled={!ready || submitting}>
            {submitting ? '注册中…' : failure ? '重试注册' : '完成注册'}
          </button>
          {onBack && (
            <button type="button" className={`${s.button} ${s.secondary}`} onClick={onBack} disabled={submitting}>
              返回登录
            </button>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}
