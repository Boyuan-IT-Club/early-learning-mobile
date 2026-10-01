import type { ReactNode } from 'react';
import { BrandMark } from '../../../shared/ui/BrandMark.tsx';
import s from './auth.module.css';

/** 账号类页面骨架：左侧品牌栏（竖屏与手机收到顶部），右侧表单卡。 */
export function AuthLayout({
  eyebrow,
  title,
  lead,
  wide = false,
  children,
}: {
  eyebrow: string;
  title: string;
  lead?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={s.screen}>
      <aside className={s.story}>
        <div className={s.brand}>
          <BrandMark tone="dark" />
          <span>叙光 NaraLight</span>
        </div>
        <div>
          <p className={s.storyTitle}>早期学习困难儿童筛查与干预</p>
          <p className={s.storyText}>
            教师工作台。儿童与教学数据只保存在这台平板上；只有注册、账号恢复、内容下载和 AI 评分需要联网。
          </p>
        </div>
      </aside>
      <main className={s.panel}>
        <section className={`${s.card} ${wide ? s.cardWide : ''}`} aria-labelledby="auth-title">
          <span className={s.eyebrow}>{eyebrow}</span>
          <h1 id="auth-title" className={s.title}>{title}</h1>
          {lead && <p className={s.lead}>{lead}</p>}
          {children}
        </section>
      </main>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={s.field}>
      <span className={required ? s.required : undefined}>{label}</span>
      {children}
      {error ? <span className={s.fieldError}>{error}</span> : hint && <span className={s.hint}>{hint}</span>}
    </label>
  );
}

export function Alert({ tone, children }: { tone: 'danger' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <p className={`${s.alert} ${s[tone]}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}
