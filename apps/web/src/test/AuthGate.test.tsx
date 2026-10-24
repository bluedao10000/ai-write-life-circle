import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import AuthGate from '../features/auth/AuthGate'
import { sessionExpiredEvent } from '../features/auth/authClient'

const { signIn, signOut, mounted } = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  mounted: vi.fn(),
}))
vi.mock('../features/auth/authClient', () => ({
  authClient: { signIn: { social: signIn }, signOut },
  sessionExpiredEvent: 'writer-agent:session-expired',
}))
vi.mock('../app/App', () => ({
  default: () => {
    mounted()
    return <textarea aria-label="草稿" defaultValue="未保存正文" />
  },
}))

beforeEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  history.replaceState(null, '', '/')
  signIn.mockResolvedValue({ data: { redirect: true } })
  signOut.mockResolvedValue({ data: { success: true } })
})

it('shows Google login without mounting or fetching the writing workspace', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 401 }))
  vi.stubGlobal('fetch', fetcher)
  render(<AuthGate />)
  await userEvent.click(
    await screen.findByRole('button', { name: '使用 Google 登录' }),
  )
  expect(signIn).toHaveBeenCalledWith({
    provider: 'google',
    callbackURL: '/',
    errorCallbackURL: '/?login=failed',
  })
  expect(mounted).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps the current draft mounted when a protected request reports session expiry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        user: { name: '作者', email: 'author@example.com' },
        projectId: 'local',
      }),
    ),
  )
  render(<AuthGate />)
  const editor = await screen.findByRole('textbox', { name: '草稿' })
  await userEvent.type(editor, '继续写作')
  window.dispatchEvent(new Event(sessionExpiredEvent))
  await screen.findByRole('alert')
  expect(screen.getByRole('textbox', { name: '草稿' })).toBe(editor)
  expect(editor).toHaveValue('未保存正文继续写作')
  expect(signIn).not.toHaveBeenCalled()
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  await userEvent.click(screen.getByRole('button', { name: '退出登录' }))
  expect(signOut).not.toHaveBeenCalled()
})

it('shows a retryable service failure rather than a demo workspace', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  )
  render(<AuthGate />)
  await screen.findByRole('alert')
  expect(mounted).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '重新检查' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
})

it('returns a public-site author to the publication wizard after Google login', async () => {
  vi.stubEnv('VITE_STORY2U_PUBLIC_SITE', 'true')
  history.replaceState(null, '', '/studio/publish')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 })),
  )
  render(<AuthGate />)
  await userEvent.click(
    await screen.findByRole('button', { name: '使用 Google 登录' }),
  )
  expect(signIn).toHaveBeenCalledWith({
    provider: 'google',
    callbackURL: '/studio/publish',
    errorCallbackURL: '/studio/publish?login=failed',
  })
  expect(mounted).not.toHaveBeenCalled()
})
