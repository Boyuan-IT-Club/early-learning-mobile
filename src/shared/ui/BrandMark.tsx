import s from './BrandMark.module.css';

/**
 * 标志占位（叙光 NaraLight 规范第一节）：标志定稿前，所有标识位置只用这个组件。
 *
 * @param tone dark = 放在深色底上；light = 放在浅色底上
 */
export function BrandMark({ tone = 'light', size = 'md' }: { tone?: 'dark' | 'light'; size?: 'md' | 'sm' }) {
  return (
    <span className={`${s.mark} ${s[tone]} ${size === 'sm' ? s.sm : ''}`} aria-hidden="true">
      叙
    </span>
  );
}
