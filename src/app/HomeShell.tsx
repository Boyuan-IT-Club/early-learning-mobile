import { AccountBanner } from '../modules/auth/index.ts';
import type { AuthService, Session } from '../modules/auth/index.ts';
import { BrandMark } from '../shared/ui/BrandMark.tsx';
import s from './HomeShell.module.css';

/**
 * 工作台外壳：云端状态条 + 头部（当前教师、退出）。业务页面接入后在 main 区渲染。
 */
export function HomeShell({ auth, session }: { auth: AuthService; session: Session }) {
  return (
    <div className={s.shell}>
      <AccountBanner session={session} />
      <header className={s.header}>
        <div className={s.brand}>
          <BrandMark size="sm" />
          <span>叙光 NaraLight</span>
        </div>
        <div className={s.user}>
          <span>{session.username}</span>
          <button type="button" className={s.logout} onClick={() => auth.logout()}>
            退出
          </button>
        </div>
      </header>
      <main className={s.main}>
        <h1 className={s.title}>教师工作台</h1>
        <p className={s.muted}>本地数据已就绪。个案、评估、课堂等业务功能正在开发中。</p>
      </main>
    </div>
  );
}
