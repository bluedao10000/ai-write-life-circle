import { useEffect, useState } from 'react'
import type { CreativeAsset, CreativeDivergence, CreativeWritingContext } from '@writer-agent/contracts'
import { Btn, Heading, IconBtn } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import AssetEditor, { type EditorResult } from './AssetEditor'
import { creativeError, kindLabels } from './labels'

const assessmentLabels: Record<CreativeDivergence['assessment'], string> = {
  fulfilled: '正文已按计划展开',
  diverged: '正文与计划不同',
  not_yet: '本章尚未写到',
  unclear: '难以判断',
}

function AssetItem({ asset }: { asset: CreativeAsset }) {
  return (
    <li className="rounded-md border border-line-soft p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="font-prose text-ui text-ink">{asset.name}</span>
        <span className="text-micro text-ink-3">{kindLabels[asset.kind]}</span>
      </div>
      {asset.summary && <p className="mt-1 text-ui-sm text-ink-2">{asset.summary}</p>}
      {asset.fields.length > 0 && (
        <dl className="mt-1 space-y-0.5 text-micro text-ink-2">
          {asset.fields.slice(0, 6).map((f) => (
            <div key={f.key}>
              <dt className="inline text-ink-3">{f.key}：</dt>
              <dd className="inline">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

/**
 * Compose-mode side panel: only author-confirmed assets selected for the
 * current chapter, plus plan/manuscript differences awaiting a decision.
 */
export default function WritingContextPanel({
  bookId,
  chapterId,
  chapters,
  onClose,
  onFlushSave,
}: {
  bookId: string
  chapterId: string
  chapters: { id: string; title: string }[]
  onClose: () => void
  onFlushSave: () => Promise<boolean>
}) {
  const [context, setContext] = useState<CreativeWritingContext | null>(null)
  const [divergences, setDivergences] = useState<CreativeDivergence[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [editing, setEditing] = useState<CreativeAsset | 'new' | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    setError('')
    Promise.all([creativeApi.context(bookId, chapterId, abort.signal), creativeApi.divergences(bookId, chapterId, abort.signal)])
      .then(([c, d]) => {
        setContext(c)
        setDivergences(d.items.filter((x) => x.status !== 'superseded'))
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(creativeError(e))
      })
    return () => abort.abort()
  }, [bookId, chapterId, tick])
  const check = async () => {
    setBusy(true)
    setError('')
    try {
      // Compare against the saved revision the author sees.
      if (!(await onFlushSave())) throw new Error('正文尚未安全保存，无法核对。')
      await creativeApi.planCheck(bookId, chapterId)
      setNotice('已加入计划核对队列。结果只会提示差异，不会修改计划或正文。')
      window.setTimeout(() => setTick((n) => n + 1), 4000)
    } catch (e) {
      setError(creativeError(e))
    } finally {
      setBusy(false)
    }
  }
  const decide = async (d: CreativeDivergence, action: 'update_plan' | 'adjust_future' | 'intentional' | 'dismiss') => {
    setBusy(true)
    try {
      await creativeApi.decideDivergence(bookId, d.divergenceId, action)
      if (action === 'update_plan') {
        const detail = await creativeApi.asset(bookId, d.assetId)
        setEditing(detail.asset)
      }
      setTick((n) => n + 1)
    } catch (e) {
      setError(creativeError(e))
    } finally {
      setBusy(false)
    }
  }
  const save = async (value: EditorResult) => {
    setBusy(true)
    try {
      if (editing === 'new') await creativeApi.createAsset(bookId, { kind: value.kind, content: value.content, status: value.status })
      else if (editing) await creativeApi.updateAsset(bookId, editing.assetId, { baseVersion: editing.version, content: value.content })
      setEditing(null)
      setTick((n) => n + 1)
    } catch (e) {
      setError(creativeError(e))
    } finally {
      setBusy(false)
    }
  }
  const section = (title: string, list: CreativeAsset[]) =>
    list.length > 0 && (
      <section className="space-y-2">
        <Heading level={3}>{title}</Heading>
        <ul className="space-y-2">
          {list.map((a) => (
            <AssetItem key={a.assetId} asset={a} />
          ))}
        </ul>
      </section>
    )
  return (
    <aside aria-label="本章设定" className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex items-center gap-2">
        <Heading level={2} className="mr-auto">
          本章设定
        </Heading>
        <IconBtn icon="x" label="关闭本章设定" onClick={onClose} />
      </div>
      <p className="text-micro text-ink-3">{context?.notice ?? '只显示作者确认的设定。'}</p>
      {error && (
        <p role="alert" className="text-ui-sm text-danger">
          {error}
        </p>
      )}
      {notice && <p role="status" className="text-ui-sm text-ink-2">{notice}</p>}
      {!context ? (
        <p className="text-ui-sm text-ink-3">正在读取…</p>
      ) : (
        <>
          {section('本章计划', context.plans)}
          {section('计划在本章回收', context.payoffs)}
          {section('相关人物', context.characters)}
          {section('相关设定', context.related)}
          {section('世界规则', context.rules)}
          {section('待决问题', context.openQuestions)}
          {context.plans.length + context.payoffs.length === 0 && <p className="text-ui-sm text-ink-3">本章还没有锚定的计划。</p>}
          <div className="flex flex-wrap gap-2">
            <Btn size="sm" variant="outline" onClick={() => setEditing('new')}>
              为本章新建计划
            </Btn>
            <Btn size="sm" disabled={busy || context.plans.length === 0} onClick={() => void check()}>
              核对计划与正文
            </Btn>
          </div>
        </>
      )}
      {divergences.length > 0 && (
        <section className="space-y-2">
          <Heading level={3}>计划核对</Heading>
          {divergences.map((d) => (
            <article key={d.divergenceId} className={`rounded-md border p-3 text-ui-sm ${d.assessment === 'diverged' ? 'border-conflict/50' : 'border-line'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{d.assetName}</span>
                <span className="text-ink-3">{assessmentLabels[d.assessment]}</span>
                {d.stale && <span className="text-warn">正文已更新，结果可能过期</span>}
              </div>
              <p className="mt-1 text-ink-3">计划：{d.planText}</p>
              {d.evidence && <blockquote className="mt-1 border-l-2 border-ink-4 pl-2 font-prose text-ink">{d.evidence.quote}</blockquote>}
              {d.explanation && <p className="mt-1 text-ink-2">{d.explanation}</p>}
              {d.question && <p className="mt-1 text-ink">{d.question}</p>}
              {d.status === 'open' ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Btn size="sm" variant="outline" disabled={busy} onClick={() => void decide(d, 'update_plan')}>
                    修改计划
                  </Btn>
                  <Btn size="sm" disabled={busy} onClick={() => void decide(d, 'adjust_future')}>
                    调整后续剧情
                  </Btn>
                  <Btn size="sm" disabled={busy} onClick={() => void decide(d, 'intentional')}>
                    保留这种变化
                  </Btn>
                  <Btn size="sm" disabled={busy} onClick={() => void decide(d, 'dismiss')}>
                    忽略
                  </Btn>
                </div>
              ) : d.decision ? (
                <p className="mt-1 text-micro text-ink-3">已决定：{{ update_plan: '修改计划', adjust_future: '调整后续剧情', intentional: '保留这种变化', dismiss: '忽略' }[d.decision.action] ?? d.decision.action}</p>
              ) : null}
            </article>
          ))}
        </section>
      )}
      {editing && (
        <AssetEditor
          title={editing === 'new' ? '新建本章计划' : `修改计划：${editing.name}`}
          kind={editing === 'new' ? 'event' : editing.kind}
          kindLocked={editing !== 'new'}
          showStatus={editing === 'new'}
          initial={editing === 'new' ? { name: '', aliases: [], summary: '', fields: [], plan: { chapterId } } : editing}
          chapters={chapters}
          busy={busy}
          error={error}
          submitLabel="保存"
          onClose={() => setEditing(null)}
          onSubmit={(v) => void save(v)}
        />
      )}
    </aside>
  )
}
