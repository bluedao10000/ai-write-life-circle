import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Btn, Dialog, Field } from '../../components/vnext/ui'
import { ApiProblemError } from '../../services/writerAgent'
import { dayLeft, fetchAccount, monthLeft, redeemCode, remaining, usableTopups, type AccountUsage, type CatalogPlan, type PlanId } from '../../services/api/accountApi'

const planName: Record<PlanId, string> = { free: 'Free', plus: 'Plus', pro: 'Pro' }
const kindName: Record<string, string> = { thinking: '灵感对话', creative: '创作整理', knowledge: '知识整理', review: '连续性审查' }
const fmt = (n: number) => n.toLocaleString('en-US')
const usd = (cents: number) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`
const date = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'UTC' })
const time = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
const limit = (n: number, unit = '') => (n === 0 ? '不限' : `${fmt(n)}${unit}`)

/** Polls the author's account; null when the API has no account endpoint. */
export function useAccount(enabled: boolean): [AccountUsage | null, (a: AccountUsage) => void] {
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
  return [account, setAccount]
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-ui-sm font-medium text-ink">{title}</h3>
      {children}
    </section>
  )
}

function planLine(a: AccountUsage) {
  if (!a.expiresAt) return a.plan === 'free' ? '免费方案' : '长期有效'
  const via = a.source === 'code' ? '兑换码' : a.source === 'payment' ? '付费' : '手动开通'
  return `${a.interval === 'year' ? '年付' : '月付'} · ${via} · ${date(a.expiresAt)}到期`
}

function Redeem({ onDone }: { onDone: (a: AccountUsage) => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim() || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const next = await redeemCode(code)
      if (next) onDone(next)
      setCode('')
      setMessage({ ok: true, text: next ? `兑换成功，当前方案 ${planName[next.plan]}。` : '兑换成功。' })
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiProblemError ? err.message : '兑换失败，请稍后重试。' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <Field label="兑换码" value={code} onChange={setCode} placeholder="WA-XXXX-XXXX-XXXX-XXXX" maxLength={40} className="flex-1 font-mono tabular-nums" />
        <Btn type="submit" variant="outline" disabled={busy || !code.trim()}>{busy ? '兑换中…' : '兑换'}</Btn>
      </div>
      {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-ok' : 'text-danger'}>{message.text}</p>}
    </form>
  )
}

function Compare({ plans, packs, current }: { plans: CatalogPlan[]; packs: AccountUsage['catalog']['packs']; current: PlanId }) {
  if (plans.length === 0) return null
  const rows: [string, (p: CatalogPlan) => ReactNode][] = [
    ['价格', (p) => (p.monthlyUsdCents ? `${usd(p.monthlyUsdCents)}/月 · ${usd(p.yearlyUsdCents)}/年` : '$0')],
    ['每月点数', (p) => fmt(p.monthly)],
    ['每日上限', (p) => fmt(p.daily)],
    ['连续性审查', (p) => (p.review ? '✓' : '—')],
    ['加油包', (p) => (p.topups ? '✓' : '—')],
    ['作品数', (p) => limit(p.books)],
    ['同时回复的灵感会话', (p) => fmt(p.sessions)],
    ['EPUB 导入', (p) => (p.importsPerMonth ? `每月 ${p.importsPerMonth} 次` : '不限')],
    ['后台任务', (p) => (p.priority ? '优先' : '普通')],
  ]
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-ui-sm">
          <thead className="text-ink-3">
            <tr>
              <th className="py-1 font-normal" />
              {plans.map((p) => (
                <th key={p.id} className={`py-1 font-normal ${p.id === current ? 'text-ink' : ''}`}>{planName[p.id]}{p.id === current ? '（当前）' : ''}</th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums text-ink-2">
            {rows.map(([name, cell]) => (
              <tr key={name}>
                <td className="py-1 pr-3 text-ink-3">{name}</td>
                {plans.map((p) => <td key={p.id} className="py-1 pr-3">{cell(p)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {packs.length > 0 && (
        <p className="text-micro text-ink-3">
          加油包（仅 Plus / Pro）：{packs.map((p) => `${fmt(p.points)} 点 ${usd(p.usdCents)}`).join('，')}。每月点数用完后才使用，12 个月内有效，不提高每日上限。
        </p>
      )}
    </>
  )
}

/** Header chip: AI points left now, with the account and plans on click. */
export default function AccountMeter({ enabled }: { enabled: boolean }) {
  const [account, setAccount] = useAccount(enabled)
  const [open, setOpen] = useState(false)
  if (!account) return null
  const left = remaining(account)
  const low = left < Math.min(account.day.limit, account.month.limit) * 0.1
  const kinds = Object.entries(account.byKind).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  return (
    <>
      {/* Narrow headers have no room; 402 messages still explain an exhausted allowance. */}
      <Btn size="sm" variant="quiet" className="max-sm:hidden" title={`AI 点数：今天剩余 ${fmt(dayLeft(account))} / 本月剩余 ${fmt(monthLeft(account))}`} onClick={() => setOpen(true)}>
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${account.paused || left === 0 ? 'bg-danger' : low ? 'bg-warn' : 'bg-ok'}`} />
        <span className="hidden tabular-nums sm:inline">AI {fmt(left)}</span>
        <span className="sr-only">AI 点数剩余 {left}</span>
      </Btn>
      {open && (
        <Dialog title="账户与方案" label="账户与方案" size="xl" onClose={() => setOpen(false)} actions={<Btn onClick={() => setOpen(false)}>关闭</Btn>} footnote="点数用完只会暂停 AI 功能，不会自动扣费。">
          <div className="space-y-5 text-ui-sm">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-ui-lg font-medium text-ink">{planName[account.plan]}</span>
              <span className="text-ink-3">{planLine(account)}</span>
            </div>
            <p className="text-ink-2">灵感对话、创作整理、知识整理和审查按实际模型用量扣点；写作、保存、阅读和发布不消耗点数。</p>
            {account.paused && <p role="alert" className="rounded-md bg-warn-soft px-3 py-2 text-ink">AI 功能暂时暂停，写作和保存不受影响。</p>}

            <Section title="AI 点数">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                <dt className="text-ink-3">今天</dt>
                <dd className="tabular-nums">已用 {fmt(account.day.used)}{account.day.reserved ? `（进行中 ${fmt(account.day.reserved)}）` : ''} / {fmt(account.day.limit)}，UTC 0 点重置</dd>
                <dt className="text-ink-3">本月</dt>
                <dd className="tabular-nums">已用 {fmt(account.month.used)}{account.month.reserved ? `（进行中 ${fmt(account.month.reserved)}）` : ''} / {fmt(account.month.limit)}，{shortDate(account.month.resetsAt)}重置</dd>
                {(account.topups.left > 0 || account.features.topups) && (
                  <>
                    <dt className="text-ink-3">加油包</dt>
                    <dd className="tabular-nums">
                      剩余 {fmt(account.topups.left)}
                      {account.topups.usedThisMonth ? `，本月已用 ${fmt(account.topups.usedThisMonth)}` : ''}
                      {account.topups.frozen && account.topups.left > 0 ? '（Free 方案下冻结，升级后恢复）' : ''}
                      {usableTopups(account) > 0 && account.topups.items[0] ? `，最早一份 ${date(account.topups.items[0].expiresAt)}到期` : ''}
                    </dd>
                  </>
                )}
                <dt className="text-ink-3">连续性审查</dt>
                <dd>{account.features.review ? '可用' : '需要 Plus 或 Pro'}</dd>
              </dl>
            </Section>

            {(kinds.length > 0 || account.recent.length > 0) && (
              <Section title="本月用量">
                {kinds.length > 0 && (
                  <ul className="flex flex-wrap gap-x-5 gap-y-1 tabular-nums">
                    {kinds.map(([k, n]) => <li key={k}><span className="text-ink-3">{kindName[k] ?? k}</span> {fmt(n)}</li>)}
                  </ul>
                )}
                {account.recent.length > 0 && (
                  <details className="text-ink-2">
                    <summary className="cursor-pointer text-ink-3">最近 {Math.min(account.recent.length, 20)} 次</summary>
                    <ul className="mt-1 space-y-0.5 tabular-nums">
                      {account.recent.slice(0, 20).map((e, i) => (
                        <li key={i} className="flex justify-between gap-4"><span>{time(e.at)} UTC · {kindName[e.kind] ?? e.kind}</span><span>{fmt(e.points)} 点</span></li>
                      ))}
                    </ul>
                  </details>
                )}
              </Section>
            )}

            {account.limits.books > 0 || account.limits.sessions > 0 ? (
              <Section title="方案限制">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 tabular-nums">
                  <dt className="text-ink-3">作品</dt>
                  <dd>{account.counts ? `${fmt(account.counts.books)} / ` : ''}{limit(account.limits.books, ' 部')}</dd>
                  <dt className="text-ink-3">EPUB 导入</dt>
                  <dd>{account.limits.importsPerMonth ? `本月 ${account.counts ? fmt(account.counts.importsThisMonth) : '—'} / ${account.limits.importsPerMonth} 次` : '不限'}</dd>
                  <dt className="text-ink-3">同时回复的灵感会话</dt>
                  <dd>{fmt(account.limits.sessions)} 个</dd>
                  <dt className="text-ink-3">后台任务</dt>
                  <dd>{account.limits.priority ? '优先处理' : '普通'}</dd>
                </dl>
              </Section>
            ) : null}

            <Section title="方案对比">
              <Compare plans={account.catalog.plans} packs={account.catalog.packs} current={account.plan} />
              <div className="flex flex-wrap items-center gap-2">
                <Btn variant="primary" disabled title="在线付款即将开放">升级（即将开放）</Btn>
                <span className="text-micro text-ink-3">在线付款开放前，可以用兑换码开通方案或加油包。</span>
              </div>
            </Section>

            <Section title="兑换码">
              <Redeem onDone={setAccount} />
            </Section>
          </div>
        </Dialog>
      )}
    </>
  )
}
