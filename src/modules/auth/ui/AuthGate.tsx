import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthService } from '../services/auth-service.ts';
import type { AuthRoute, Session } from '../types.ts';
import { ActivatePage } from './ActivatePage.tsx';
import { Alert, AuthLayout } from './AuthLayout.tsx';
import { LoginPage } from './LoginPage.tsx';
import { ProfilePage } from './ProfilePage.tsx';
import { RecoverPage } from './RecoverPage.tsx';
import { RegisterPage } from './RegisterPage.tsx';

type Step =
  | { kind: 'route' }
  | { kind: 'register'; activationCode: string }
  | { kind: 'recover'; knownUsername: string | null };

/**
 * 启动路由（设计 5.6）：没有本地账号 → 激活；未登录 → 登录；资料未填 → 资料；否则进入工作台。
 *
 * 工作台内容由调用方通过 `children(session, openRecover)` 渲染；账号状态变化（停用信号、解锁超时）会自动回到对应页面。
 */
export function AuthGate({
  auth,
  children,
}: {
  auth: AuthService;
  children: (session: Session, openRecover: () => void) => ReactNode;
}) {
  const [route, setRoute] = useState<AuthRoute | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'route' });
  const [session, setSession] = useState<Session | null>(auth.getSession());
  const [notice, setNotice] = useState<string | null>(null);

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

  const openRecover = () => {
    const knownUsername = route?.kind === 'LOGIN' ? route.username : session?.username ?? null;
    setStep({ kind: 'recover', knownUsername });
  };

  if (step.kind === 'register') {
    return (
      <RegisterPage
        auth={auth}
        activationCode={step.activationCode}
        onBack={() => setStep({ kind: 'route' })}
        onRegistered={() => setStep({ kind: 'route' })}
        onRecover={() => setStep({ kind: 'recover', knownUsername: null })}
      />
    );
  }

  if (step.kind === 'recover') {
    return (
      <RecoverPage
        auth={auth}
        knownUsername={step.knownUsername}
        onBack={() => setStep({ kind: 'route' })}
        onRecovered={result => {
          setNotice(result.createdLocalAccount
            ? '账号已恢复。原设备上的业务数据不会自动出现在这台平板上，请用离线备份导入。'
            : '账号已恢复，请使用新密码登录。');
          setStep({ kind: 'route' });
        }}
      />
    );
  }

  if (!route) {
    return (
      <AuthLayout eyebrow="准备中" title="正在读取本机账号…">
        <span />
      </AuthLayout>
    );
  }

  switch (route.kind) {
    case 'ACTIVATE':
      return (
        <ActivatePage
          auth={auth}
          onVerified={activationCode => setStep({ kind: 'register', activationCode })}
          onRecover={openRecover}
        />
      );
    case 'LOGIN':
      return (
        <LoginPage
          auth={auth}
          username={route.username}
          lockedUntil={route.lockedUntil}
          onLoggedIn={refresh}
          onRecover={openRecover}
        />
      );
    case 'PROFILE':
      return <ProfilePage auth={auth} onSaved={refresh} />;
    case 'HOME':
      if (!session) return null;
      return (
        <>
          {notice && <Alert tone="info">{notice}</Alert>}
          {children(session, openRecover)}
        </>
      );
  }
}
