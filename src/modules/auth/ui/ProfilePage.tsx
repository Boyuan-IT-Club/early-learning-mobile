import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthService } from '../services/auth-service.ts';
import type { TeacherProfile } from '../types.ts';
import { Alert, AuthLayout, Field } from './AuthLayout.tsx';
import { describeError } from './messages.ts';
import s from './auth.module.css';

const EMPTY: TeacherProfile = {
  realName: null,
  professionalBackground: null,
  jobTitle: null,
  organization: null,
  yearsOfExperience: null,
  workExperience: null,
  teachingExpertise: null,
};

/**
 * 教师资料（PRD 2.3）：真实姓名、专业学习背景必填，其余选填。只保存在本机，不上传云端。
 * 报告上的教师姓名取自这里。
 */
export function ProfilePage({ auth, onSaved }: { auth: AuthService; onSaved: () => void }) {
  const [profile, setProfile] = useState<TeacherProfile>(EMPTY);
  const [years, setYears] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void auth.profile().then(saved => {
      if (!active) return;
      setProfile(saved);
      setYears(saved.yearsOfExperience === null ? '' : String(saved.yearsOfExperience));
    });
    return () => { active = false; };
  }, [auth]);

  const set = (key: keyof TeacherProfile) => (value: string) => setProfile(current => ({ ...current, [key]: value }));
  const ready = Boolean(profile.realName?.trim()) && Boolean(profile.professionalBackground?.trim());

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await auth.saveProfile({ ...profile, yearsOfExperience: years.trim() === '' ? null : Number(years) });
      onSaved();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout eyebrow="教师资料" title="完善资料" lead="资料只保存在这台平板上，用于正式报告的教师署名。" wide>
      <form className={s.form} onSubmit={submit} noValidate>
        <div className={s.grid2}>
          <TextField label="真实姓名" value={profile.realName} onChange={set('realName')} required />
          <TextField label="专业学习背景" value={profile.professionalBackground} onChange={set('professionalBackground')} required />
          <TextField label="职称" value={profile.jobTitle} onChange={set('jobTitle')} />
          <TextField label="工作单位" value={profile.organization} onChange={set('organization')} />
          <Field label="工作年限">
            <input className={s.input} inputMode="numeric" value={years} onChange={event => setYears(event.target.value)} />
          </Field>
          <TextField label="教学擅长" value={profile.teachingExpertise} onChange={set('teachingExpertise')} />
        </div>
        <TextField label="主要工作经历" value={profile.workExperience} onChange={set('workExperience')} />
        {failure && <Alert tone="danger">{failure}</Alert>}
        <div className={s.actions}>
          <button className={`${s.button} ${s.primary}`} disabled={!ready || submitting}>
            {submitting ? '保存中…' : '保存并进入工作台'}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

function TextField({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <Field label={label} required={required}>
      <input className={s.input} value={value ?? ''} onChange={event => onChange(event.target.value)} />
    </Field>
  );
}
