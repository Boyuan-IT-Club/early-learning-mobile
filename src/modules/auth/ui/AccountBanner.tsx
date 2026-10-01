import type { Session } from '../types.ts';
import s from './auth.module.css';

const RESTRICTED: Record<Exclude<Session['accountStatus'], 'ACTIVE'>, { title: string; body: string }> = {
  DISABLED: {
    title: '账号已被机构停用',
    body: '可以继续查看与导出已有数据，但不能新建或修改业务。管理员重新启用后，联网即自动恢复。',
  },
  REVOKED: {
    title: '账号的激活码已被撤销',
    body: '可以继续查看与导出已有数据，但不能新建或修改业务。请联系管理员处理。',
  },
  UNBOUND: {
    title: '本设备已被解绑',
    body: '可以继续查看与导出已有数据。若要继续使用，请联系管理员签发恢复码，在「账号恢复」中重新绑定。',
  },
};

/**
 * 首页顶部的账号状态条。受限与云端失联都是"需要处理"（黄），不是失败（红）。
 * 正常状态不渲染，不占垂直空间。
 */
export function AccountBanner({ session, onRecover }: { session: Session; onRecover: () => void }) {
  if (session.accountStatus !== 'ACTIVE') {
    const copy = RESTRICTED[session.accountStatus];
    return (
      <div className={s.banner} role="status">
        <span>
          <span className={s.bannerTitle}>{copy.title}</span> {copy.body}
        </span>
        {session.accountStatus === 'UNBOUND' && (
          <button type="button" className={s.link} onClick={onRecover}>账号恢复</button>
        )}
      </div>
    );
  }
  if (session.cloudSession === 'LOST') {
    return (
      <div className={s.banner} role="status">
        <span>
          <span className={s.bannerTitle}>云端连接已失效</span> 本地业务不受影响；课程同步与 AI 评分暂不可用。请联系管理员签发恢复码。
        </span>
        <button type="button" className={s.link} onClick={onRecover}>账号恢复</button>
      </div>
    );
  }
  return null;
}
