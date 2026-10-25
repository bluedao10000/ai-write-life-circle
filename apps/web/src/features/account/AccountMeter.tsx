import { useEffect, useState } from 'react'
import { Btn, Dialog } from '../../components/vnext/ui'
import { fetchAccount, remaining, type AccountUsage } from '../../services/api/accountApi'

const planName = { free: 'Free', plus: 'Plus', pro: 'Pro' } as const
const fmt = (n: number) => n.toLocaleString('en-US')
const resetDate = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'UTC' })

/** Polls the author's AI points; hidden when the API has no account endpoint. */
export function useAccount(enabled: boolean): AccountUsage | null {
  const [account, setAccount] = useState<AccountUsage | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = () => void fetchAccount().then((a) => alive && setAccount(a)).catch(() => alive && setAccount(null))
    load()
    const timer = window.setInterval(load, 60_000)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [enabled])
  return account
}

/** Header chip: AI points left now, with plan details on click. */
export default function AccountMeter({ enabled }: { enabled: boolean }) {
  const account = useAccount(enabled)
  const [open, setOpen] = useState(false)
  if (!account) return null
  const left = remaining(account)
  const low = left < Math.min(account.day.limit, account.month.limit) * 0.1
  return (
    <>
      {/* Narrow headers have no room; 402 messages still explain an exhausted allowance. */}
      <Btn size="sm" variant="quiet" className="max-sm:hidden" title={`AI 点数：今天剩余 ${fmt(Math.max(0, account.day.limit - account.day.used - account.day.reserved))} / 本月剩余 ${fmt(Math.max(0, account.month.limit - account.month.used - account.month.reserved))}`} onClick={() => setOpen(true)}>
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${account.paused || left === 0 ? 'bg-danger' : low ? 'bg-warn' : 'bg-ok'}`} />
        <span className="hidden tabular-nums sm:inline">AI {fmt(left)}</span>
        <span className="sr-only">AI 点数剩余 {left}</span>
      </Btn>
      {open && (
        <Dialog title="AI 点数" label="AI 点数" onClose={() => setOpen(false)} actions={<Btn onClick={() => setOpen(false)}>关闭</Btn>}>
          <div className="space-y-4 text-ui-sm">
            <p className="text-ink-2">
              当前方案 <span className="font-medium text-ink">{planName[account.plan]}</span>。灵感对话、创作整理、知识整理和审查按实际模型用量扣点；写作、保存、阅读和发布不消耗点数。
            </p>
            {account.paused && <p role="alert" className="rounded-md bg-warn-soft px-3 py-2 text-ink">AI 功能暂时暂停，写作和保存不受影响。</p>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-ink-3">今天</dt>
              <dd className="tabular-nums">已用 {fmt(account.day.used)}{account.day.reserved ? `（进行中 ${fmt(account.day.reserved)}）` : ''} / {fmt(account.day.limit)}，UTC 0 点重置</dd>
              <dt className="text-ink-3">本月</dt>
              <dd className="tabular-nums">已用 {fmt(account.month.used)}{account.month.reserved ? `（进行中 ${fmt(account.month.reserved)}）` : ''} / {fmt(account.month.limit)}，{resetDate(account.month.resetsAt)}重置</dd>
              <dt className="text-ink-3">连续性审查</dt>
              <dd>{account.features.review ? '可用' : '需要 Plus 或 Pro'}</dd>
            </dl>
            <table className="w-full text-left">
              <thead className="text-ink-3">
                <tr><th className="py-1 font-normal" /><th className="py-1 font-normal">Free</th><th className="py-1 font-normal">Plus</th><th className="py-1 font-normal">Pro</th></tr>
              </thead>
              <tbody className="tabular-nums text-ink-2">
                <tr><td className="py-1 text-ink-3">价格</td><td>$0</td><td>$4.99/月 · $49/年</td><td>$12.99/月 · $129/年</td></tr>
                <tr><td className="py-1 text-ink-3">每月点数</td><td>1,500</td><td>6,000</td><td>18,000</td></tr>
                <tr><td className="py-1 text-ink-3">每日上限</td><td>300</td><td>1,500</td><td>4,000</td></tr>
                <tr><td className="py-1 text-ink-3">审查</td><td>—</td><td>✓</td><td>✓</td></tr>
              </tbody>
            </table>
            <p className="text-micro text-ink-3">付费方案即将开放。点数用完只会暂停 AI 功能，不会自动扣费。</p>
          </div>
        </Dialog>
      )}
    </>
  )
}
