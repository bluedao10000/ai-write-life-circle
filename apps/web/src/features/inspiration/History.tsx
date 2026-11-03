// 灵感 · 历史会话 (Figma Make idea/History.tsx): new chat, search, the last
// seven days and earlier. A collapsible sidebar on desktop, a drawer on mobile.
// Every row is a persisted ThinkingSession of this author and work.
import { useState, type ReactNode } from 'react'
import type { ThinkingSession } from '@writer-agent/contracts'
import { Icon, Row, TextInput, ago } from '../../components/vnext/ui'

type Summary = Pick<ThinkingSession, 'sessionId' | 'title' | 'createdAt' | 'status'>
const WEEK = 7 * 24 * 36e5
const at = (iso: string) => Date.parse(iso) || Date.now()

export default function History({ sessions, active, locked, onPick, onNew, aside, head, footer }: {
  sessions: Summary[]
  active: string | null
  /** A request is in flight; switching would orphan its result in the view. */
  locked: boolean
  onPick: (id: string) => void
  onNew: () => void
  /** Same row as 新对话 (desktop: collapse the sidebar). */
  aside?: ReactNode
  /** Before the list (mobile: brand, work and main navigation). */
  head?: ReactNode
  footer?: ReactNode
}) {
  const [q, setQ] = useState('')
  const t = q.trim()
  const list = sessions.filter((s) => !t || s.title.includes(t)).sort((a, b) => at(b.createdAt) - at(a.createdAt))
  const now = Date.now()
  return (
    <div className="flex h-full min-h-0 flex-col">
      {head}
      <div className="flex items-center gap-1 px-3 pt-3">
        <Row onClick={onNew} disabled={locked} className="flex min-h-9 flex-1 items-center gap-2.5 px-2.5 text-ui text-ink max-md:min-h-11">
          <Icon name="plus" />
          新对话
        </Row>
        {aside}
      </div>
      {/* 移动端：44px 触控高度，16px 字号避免 iOS 聚焦时自动放大 */}
      <div className="px-3 pt-2">
        <TextInput label="搜索历史会话" value={q} onChange={setQ} placeholder="搜索历史" className="max-md:h-11 max-md:[&_input]:text-read" />
      </div>
      <nav aria-label="历史会话" className="scroll mt-5 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {!list.length && <p className="px-2.5 py-6 text-ui-sm text-ink-3">{t ? `没有找到与“${t}”相关的讨论` : '还没有讨论。你提出的第一个问题会出现在这里。'}</p>}
        <Group title="最近的讨论" list={list.filter((s) => now - at(s.createdAt) < WEEK)} active={active} locked={locked} onPick={onPick} />
        <Group title="更早的讨论" list={list.filter((s) => now - at(s.createdAt) >= WEEK)} active={active} locked={locked} onPick={onPick} />
      </nav>
      {footer && <div className="shrink-0 border-t border-line-soft px-4 py-3">{footer}</div>}
    </div>
  )
}

function Group({ title, list, active, locked, onPick }: { title: string; list: Summary[]; active: string | null; locked: boolean; onPick: (id: string) => void }) {
  if (!list.length) return null
  return (
    <section className="mb-5">
      <div className="px-2.5 pb-1.5 text-micro text-ink-3">{title}</div>
      <ul className="space-y-0.5">
        {list.map((s) => {
          const on = s.sessionId === active
          return (
            <li key={s.sessionId}>
              <Row
                active={on}
                disabled={locked && !on}
                onClick={() => onPick(s.sessionId)}
                className={`relative px-2.5 py-2 max-md:py-2.5 ${on ? 'before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent' : ''}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`min-w-0 flex-1 truncate text-ui ${on ? 'font-medium text-ink' : 'text-ink-2'}`}>{s.title}</span>
                  {s.status === 'running' && <span className="shrink-0 text-micro text-ai">回复中</span>}
                </span>
                <span className="mt-0.5 block text-micro text-ink-3">{ago(at(s.createdAt))}</span>
              </Row>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
