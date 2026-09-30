import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthService } from '../services/auth-service.ts';
import { Alert, AuthLayout, Field } from './AuthLayout.tsx';
import { describeError } from './messages.ts';
import s from './auth.module.css';

/** 第一步：校验激活码（PRD 2.2-2：先校验激活码，再开放注册）。 */
export function ActivatePage({
  auth,
  onVerified,
  onRecover,
}: {
  auth: AuthService;
  onVerified: (activationCode: string) => void;
  onRecover: () => void;
}) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const filled = code.replace(/[\s-]/g, '').length >= 16;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!filled || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await auth.verifyLicense(code);
      onVerified(code.trim());
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="激活"
      title="输入激活码"
      lead="激活码由机构管理员发放，一个激活码只能注册一个教师账号。本步骤需要联网。"
    >
      <form className={s.form} onSubmit={submit} noValidate>
        <Field label="激活码" hint="16 位，形如 XXXX-XXXX-XXXX-XXXX；大小写与连字符都可以" required>
          <input
            className={`${s.input} ${s.code}`}
            value={code}
            onChange={event => setCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
          />
        </Field>
        {failure && <Alert tone="danger">{failure}</Alert>}
        <div className={s.actions}>
          <button className={`${s.button} ${s.primary}`} disabled={!filled || submitting}>
            {submitting ? '校验中…' : '下一步'}
          </button>
          <button type="button" className={s.link} onClick={onRecover}>
            已有账号？换设备或重装后找回
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
