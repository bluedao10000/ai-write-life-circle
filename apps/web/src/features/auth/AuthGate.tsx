import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { authClient, sessionExpiredEvent } from './authClient'
import { clearScopedSession, setStorageScope } from '../../services/storageScope'
import { clearScopeDrafts, countScopeDrafts } from '../../services/localChapterDraft'

const App = lazy(() => window.location.pathname==='/studio/publish'?import('../../site/Publish'):import('../../app/App'))
type Author = { name: string; email: string; scope?: string }

export default function AuthGate() {
  const [user, setUser] = useState<Author | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/session', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (response.status === 401) return
      if (!response.ok) throw new Error(response.status === 403 ? '此 Google 账号无法登录，请使用已验证邮箱的账号。' : '登录服务暂时不可用，请稍后重试。')
      const value = await response.json() as { user: Author; projectId: string }
      if (controller.signal.aborted) return
      // Partition drafts and selected-work state by account before the studio loads.
      setStorageScope(value.user.scope)
      setUser(value.user)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '无法检查登录状态。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [attempt])
  useEffect(() => {
    const expired = () => setMessage('登录已过期。当前草稿仍保留；请重新登录后重试保存，也可以先导出草稿。')
    window.addEventListener(sessionExpiredEvent, expired)
    return () => window.removeEventListener(sessionExpiredEvent, expired)
  }, [])
  const signIn = useCallback(async () => {
    setBusy(true)
    setMessage('')
    try {
      const callbackURL=import.meta.env.VITE_STORY2U_PUBLIC_SITE==='true'?(window.location.pathname==='/studio/publish'?'/studio/publish':'/studio'):'/'
      const result = await authClient.signIn.social({ provider: 'google', callbackURL, errorCallbackURL: callbackURL+'?login=failed' })
      if (result.error) throw new Error('暂时无法连接 Google 登录，请稍后重试。')
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : '登录失败，请重试。')
      setBusy(false)
    }
  }, [])
  const signOut = async () => {
    const drafts = user ? countScopeDrafts() : 0
    const question = drafts
      ? `此浏览器还有 ${drafts} 章未保存到服务器的本地草稿。退出后会从此浏览器删除，其他账号也无法看到。请先保存或导出。仍要退出？`
      : '退出登录前，请确认正文已保存或已导出当前草稿。是否退出？'
    if (user && !window.confirm(question)) return
    setBusy(true)
    try {
      const result = await authClient.signOut()
      if (result.error) throw new Error('退出失败，请重试。')
      // A shared browser keeps nothing of this account after sign-out.
      clearScopeDrafts()
      clearScopedSession()
      window.location.assign('/')
    } catch {
      setMessage('退出失败，请稍后重试。')
      setBusy(false)
    }
  }
  if (loading) return <div className="grid h-dvh place-items-center bg-page text-ink-2" role="status">正在检查登录状态…</div>
  if (!user) return (
    <main className="grid min-h-dvh place-items-center bg-page px-6 text-ink">
      <section className="w-full max-w-sm space-y-6 rounded-2xl border border-line bg-panel p-8 shadow-sm" aria-labelledby="login-title">
        <div className="space-y-2"><p className="font-prose text-ink-2">Writer Agent</p><h1 id="login-title" className="text-2xl">回到你的写作工作台</h1><p className="text-sm text-ink-2">使用 Google 账号登录。每个账号拥有自己独立的作品。</p></div>
        {(message || new URLSearchParams(window.location.search).get('login') === 'failed') && <p role="alert" className="text-sm text-danger">{message || '登录未完成，请重试。'}</p>}
        <button type="button" disabled={busy} onClick={() => void signIn()} className="w-full rounded-lg border border-line px-4 py-3 text-sm disabled:opacity-50">{busy ? '正在前往 Google…' : '使用 Google 登录'}</button>
        {message && <div className="flex gap-4 text-sm"><button type="button" onClick={() => { setLoading(true); setMessage(''); setAttempt(value => value + 1) }}>重新检查</button><button type="button" disabled={busy} onClick={() => void signOut()}>退出当前账号</button></div>}
        <p className="text-xs text-ink-3">审查正文前，你仍需确认本次发送给模型的内容范围。</p>
      </section>
    </main>
  )
  return (
    <div className={window.location.pathname==='/studio/publish'?'flex min-h-dvh flex-col bg-page text-ink':'authenticated-workspace flex h-dvh flex-col bg-page text-ink'}>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-b border-line px-3 py-1 text-xs text-ink-2">
        {message && <><p role="alert" className="mr-auto text-danger">{message}</p><button type="button" disabled={busy} onClick={() => void signIn()}>重新登录</button></>}
        <span>{user.email}</span><button type="button" disabled={busy} onClick={() => void signOut()}>退出登录</button>
      </div>
      <div className="min-h-0 flex-1"><Suspense fallback={<p role="status">正在加载作品…</p>}><App /></Suspense></div>
    </div>
  )
}
