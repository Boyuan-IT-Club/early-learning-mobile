import type { Session } from '../types.ts';
import s from './auth.module.css';

const CLOUD_UNAVAILABLE: Record<Exclude<Session['cloud'], 'OK'>, { title: string; body: string }> = {
  DISABLED: {
    title: '云端功能暂不可用',
    body: '账号已被机构停用。本地业务不受影响；管理员重新启用后，联网即自动恢复。',
  },
  REVOKED: {
    title: '云端功能不可用',
    body: '账号的激活码已被撤销。本地业务不受影响；如需继续使用云端功能，请联系管理员。',
  },
  LOST: {
    title: '云端凭证已失效',
    body: '本地业务不受影响；内容下载与 AI 评分不再可用。如需继续使用，请向管理员领取新的激活码注册新账号。',
  },
};

/**
 * 首页顶部的云端状态条。云端不可用只是"需要知道"（黄），不是失败（红），也不限制本地业务。
 * 正常状态不渲染，不占垂直空间。
 */
export function AccountBanner({ session }: { session: Session }) {
  if (session.cloud === 'OK') return null;
  const copy = CLOUD_UNAVAILABLE[session.cloud];
  return (
    <div className={s.banner} role="status">
      <span>
        <span className={s.bannerTitle}>{copy.title}</span> {copy.body}
      </span>
    </div>
  );
}
