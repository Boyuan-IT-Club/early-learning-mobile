import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { getDatabase } from './database'
import { getServices } from './services'
import type { AppServices } from './services'
import { HomeShell } from './HomeShell'
import { AuthGate } from '../modules/auth/index.ts'
import { AppError } from '../shared/contracts/errors'
import '../App.css'

type Startup = 'loading' | 'ready' | 'preview' | 'failed'

export default function Application() {
  const [status, setStatus] = useState<Startup>('loading')
  const [attempt, setAttempt] = useState(0)
  const [message, setMessage] = useState('')
  const [services, setServices] = useState<AppServices | null>(null)

  useEffect(() => {
  let active = true

  // 非安卓连接不连数据库，只预览
  const run = async (): Promise<void> => {
    if (Capacitor.getPlatform() !== 'android') {
      if (active) setStatus('preview')
      return
    }
    // 初始化数据库
    try {
      // open + migrate
      const database = getDatabase()
      await database.initialize()
      if (!active) return
      setServices(getServices(database))
      setStatus('ready')
    } catch (error) {
      if (!active) return
      setMessage(
        error instanceof AppError ? error.message : '应用暂时无法启动，请重试。',
      )
      setStatus('failed')
    }
  }

  void run()
  // StrictMode 重挂载不关闭全局数据库；连接由 app 生命周期统一拥有。
  return () => {
    active = false
  }
}, [attempt])

  // 账号生命周期：切后台计时、回前台超时则锁定；启动与恢复联网时同步云端账号状态
  useEffect(() => {
    if (!services) return
    const { auth } = services
    const onVisibility = () => (document.hidden ? auth.markBackground() : auth.markForeground())
    const onOnline = () => void auth.syncStatus()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    void auth.syncStatus()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [services])

  if (status === 'ready' && services) {
    return (
      <AuthGate auth={services.auth}>
        {(session, openRecover) => <HomeShell auth={services.auth} session={session} onRecover={openRecover} />}
      </AuthGate>
    )
  }

  return (
    <main className="app-shell">
      <h1>早期学习困难儿童筛查与干预系统</h1>
      <p>教师工作台</p>
      <section aria-live="polite" aria-busy={status === 'loading'}>
        {status === 'loading' && <p>正在准备本地数据…</p>}
        {status === 'preview' && <><h2>浏览器预览</h2><p>此环境不保存业务数据，请在 Android 应用中使用本地功能。</p></>}
        {status === 'failed' && <>
          <h2>暂时无法进入工作台</h2>
          <p role="alert">{message}</p>
          <button type="button" onClick={() => { setStatus('loading'); setAttempt(value => value + 1) }}>重试</button>
        </>}
      </section>
    </main>
  )
}
