import { useEffect, useRef, useState } from 'react'
import type { CreativeTurn, ThinkingSession } from '@writer-agent/contracts'
import { Btn, Choice, Heading } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import CreativeConsent from './CreativeConsent'
import ProposalList from './ProposalList'
import { creativeError, turnStatusLabels } from './labels'
import { useCreativeOverview } from './useCreativeOverview'

const POLL_MS = 3000
const active = (t: CreativeTurn) => t.status === 'awaiting' || t.status === 'queued'

/**
 * Side panel of the inspiration space. Organizing runs on the server after
 * each reply; this panel only displays progress and lets the author review.
 * Polling here refreshes the view and never drives business reliability.
 */
export default function InspirationOrganizer({
  bookId,
  session,
  chapters,
  onOpenBook,
}: {
  bookId: string
  session: ThinkingSession | null
  chapters: { id: string; title: string }[]
  onOpenBook: () => void
}) {
  const { overview, error: overviewError, refresh } = useCreativeOverview(bookId, true)
  const [turns, setTurns] = useState<CreativeTurn[]>([])
  const [consent, setConsent] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sessionId = session?.sessionId
  const settings = overview?.settings
  const organizedCount = useRef(0)
  const lastUser = [...(session?.messages ?? [])].reverse().find((m) => m.role === 'user')
  const answer = session?.messages.find((m) => m.id === `${lastUser?.id}-answer`)
  useEffect(() => {
    setTurns([])
    organizedCount.current = 0
    if (!sessionId || !settings?.enabled) return
    let alive = true
    let timer: number | undefined
    const load = async () => {
      try {
        const page = await creativeApi.turns(bookId, sessionId)
        if (!alive) return
        setTurns(page.items)
        const done = page.items.filter((t) => t.status === 'organized').length
        if (done !== organizedCount.current) {
          organizedCount.current = done
          setRefreshKey((n) => n + 1)
        }
        if ((page.items.some(active) || session?.status === 'running') && document.visibilityState === 'visible') timer = window.setTimeout(() => void load(), POLL_MS)
      } catch (e) {
        if (alive) setError(creativeError(e))
      }
    }
    void load()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [bookId, sessionId, settings?.enabled, session?.status, session?.messages.length])
  const lastTurn = turns.find((t) => t.messageId === lastUser?.id)
  const canOrganize = !!lastUser && answer?.status === 'completed' && (!lastTurn || ['failed', 'skipped', 'expired', 'cancelled'].includes(lastTurn.status))
  const organize = async () => {
    if (!sessionId || !lastUser) return
    setBusy(true)
    setError('')
    try {
      const turn = await creativeApi.organize(bookId, sessionId, lastUser.id)
      setTurns((all) => [...all.filter((t) => t.turnKey !== turn.turnKey), turn])
    } catch (e) {
      setError(creativeError(e))
    } finally {
      setBusy(false)
    }
  }
  const setAuto = async (on: boolean) => {
    try {
      await creativeApi.settings(bookId, 'auto', { autoOrganize: on })
      refresh()
    } catch (e) {
      setError(creativeError(e))
    }
  }
  return (
    <aside aria-label="灵感整理" className="space-y-4">
      <div className="flex items-center gap-2">
        <Heading level={2} className="mr-auto">
          灵感整理
        </Heading>
        <Btn size="sm" variant="link" onClick={onOpenBook}>
          在书中管理设定
        </Btn>
      </div>
      {(overviewError || error) && (
        <p role="alert" className="text-ui-sm text-danger">
          {overviewError || error}
        </p>
      )}
      {!settings ? (
        <p className="text-ui-sm text-ink-3">正在读取整理设置…</p>
      ) : !settings.enabled || settings.needsModelConsent ? (
        <div className="space-y-2 rounded-lg border border-line p-4 text-ui-sm">
          <p className="text-ink">
            {settings.needsModelConsent ? '模型配置已变化，需要重新确认后才能继续整理。' : '把讨论中的人物、世界规则、剧情和伏笔整理成待审核的设定候选。没有正文也可以开始。'}
          </p>
          <p className="text-ink-3">候选不会自动成为正式设定；你也可以在“书”里直接创建和编辑设定。</p>
          <Btn variant="primary" size="sm" onClick={() => setConsent(true)}>
            {settings.needsModelConsent ? '重新确认' : '启用灵感整理'}
          </Btn>
        </div>
      ) : (
        <div className="space-y-2 text-ui-sm">
          <p className="text-micro text-ink-3">
            {settings.model.model} · 今日已预留 {settings.budgetTokens} / {settings.dailyTokenBudget} Token
            {settings.paused ? ' · 已暂停' : ''}
          </p>
          <Choice checked={settings.autoOrganize} onChange={(on) => void setAuto(on)}>
            每轮回复后自动整理
          </Choice>
          {sessionId && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-3">本轮：{lastTurn ? turnStatusLabels[lastTurn.status] : lastUser ? (settings.autoOrganize ? '等待回复完成' : '未整理') : '尚无讨论'}</span>
              {lastTurn?.summary && <span className="text-ink-2">{lastTurn.summary}</span>}
              {canOrganize && (
                <Btn size="sm" variant="outline" disabled={busy} onClick={() => void organize()}>
                  整理本轮
                </Btn>
              )}
            </div>
          )}
        </div>
      )}
      {sessionId ? (
        <ProposalList bookId={bookId} sessionId={sessionId} refreshKey={refreshKey} chapters={chapters} onDecided={refresh} emptyText="这次会话还没有待审核的设定候选。" />
      ) : (
        <p className="text-ui-sm text-ink-3">选择或新建一次灵感会话后，这里会显示从讨论中整理出的候选。</p>
      )}
      {consent && settings && (
        <CreativeConsent
          bookId={bookId}
          settings={settings}
          onClose={() => setConsent(false)}
          onEnabled={() => {
            setConsent(false)
            refresh()
          }}
        />
      )}
    </aside>
  )
}
