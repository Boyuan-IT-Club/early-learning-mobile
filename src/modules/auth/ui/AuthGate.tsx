import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthService } from '../services/auth-service.ts';
import type { AuthRoute, Session } from '../types.ts';
import { AuthLayout } from './AuthLayout.tsx';
import { LoginPage } from './LoginPage.tsx';
import { RegisterPage } from './RegisterPage.tsx';

/**
 * 启动路由：本机没有账号 → 注册；未登录 → 登录（可转去用新激活码注册）；否则进入工作台。
 *
 * 工作台内容由调用方通过 `children(session)` 渲染；会话变化（退出、后台超时、云端状态变化）会自动刷新。
 */
export function AuthGate({
  auth,
  children,
}: {
  auth: AuthService;
  children: (session: Session) => ReactNode;
}) {
  const [route, setRoute] = useState<AuthRoute | null>(null);
  const [registering, setRegistering] = useState(false);
  const [session, setSession] = useState<Session | null>(auth.getSession());

  // 递增即重新读取路由；读取在 effect 里异步完成，结果到达时才 setState
  const [routeVersion, setRouteVersion] = useState(0);
  const refresh = useCallback(() => setRouteVersion(value => value + 1), []);

  useEffect(() => {
    let active = true;
    void auth.route().then(next => {
      if (active) setRoute(next);
    });
    return () => { active = false; };
  }, [auth, routeVersion]);

  useEffect(() => auth.onSessionChange(next => {
    setSession(next);
    refresh();
  }), [auth, refresh]);

  if (!route) {
    return (
      <AuthLayout eyebrow="准备中" title="正在读取本机账号…">
        <span />
      </AuthLayout>
    );
  }

  if (route.kind === 'REGISTER' || (route.kind === 'LOGIN' && registering)) {
    return (
      <RegisterPage
        auth={auth}
        onRegistered={() => setRegistering(false)}
        onBack={route.kind === 'LOGIN' ? () => setRegistering(false) : undefined}
      />
    );
  }

  if (route.kind === 'LOGIN') {
    return (
      <LoginPage
        auth={auth}
        lastUsername={route.lastUsername}
        onLoggedIn={refresh}
        onRegister={() => setRegistering(true)}
      />
    );
  }

  return session ? <>{children(session)}</> : null;
}
