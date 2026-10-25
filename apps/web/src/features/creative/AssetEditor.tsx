import { useState } from 'react'
import type { CreativeContent, CreativeKind } from '@writer-agent/contracts'
import { Btn, Dialog, Select } from '../../components/vnext/ui'
import { kindLabels } from './labels'

const planKinds: CreativeKind[] = ['plot_line', 'event', 'foreshadowing', 'character_arc']

export type EditorResult = { kind: CreativeKind; content: CreativeContent; status: 'draft' | 'accepted' }

/**
 * One form for author-created assets, direct edits and "edit then accept" of
 * AI proposals. It only shapes content; persistence and CAS happen in the caller.
 */
export default function AssetEditor({
  title,
  initial,
  kind: initialKind,
  kindLocked,
  kinds,
  showStatus,
  submitLabel,
  chapters,
  busy,
  error,
  note,
  onSubmit,
  onClose,
}: {
  title: string
  initial?: CreativeContent
  kind?: CreativeKind
  kindLocked?: boolean
  /** Restrict the kind choice to one book section. */
  kinds?: CreativeKind[]
  showStatus?: boolean
  submitLabel: string
  chapters: { id: string; title: string }[]
  busy?: boolean
  error?: string
  note?: string
  onSubmit: (value: EditorResult) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<CreativeKind>(initialKind ?? 'character')
  const [name, setName] = useState(initial?.name ?? '')
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join('、'))
  const [summary, setSummary] = useState(initial?.summary ?? '')
  const [fields, setFields] = useState(initial?.fields?.length ? initial.fields : [{ key: '', value: '' }])
  const [chapterId, setChapterId] = useState(initial?.plan?.chapterId ?? '')
  const [payoffChapterId, setPayoffChapterId] = useState(initial?.plan?.payoffChapterId ?? '')
  const [status, setStatus] = useState<'draft' | 'accepted'>('accepted')
  const isPlan = planKinds.includes(kind)
  const submit = () => {
    const plan = isPlan && (chapterId || payoffChapterId) ? { ...(chapterId ? { chapterId } : {}), ...(payoffChapterId ? { payoffChapterId } : {}) } : undefined
    onSubmit({
      kind,
      status,
      content: {
        name: name.trim(),
        aliases: aliases.split(/[,，、]/).map((a) => a.trim()).filter(Boolean),
        summary: summary.trim(),
        fields: fields.map((f) => ({ key: f.key.trim(), value: f.value.trim() })).filter((f) => f.key && f.value),
        ...(plan ? { plan } : {}),
      },
    })
  }
  const chapterOptions = [{ value: '', label: '不锚定章节' }, ...chapters.map((c) => ({ value: c.id, label: c.title }))]
  return (
    <Dialog
      title={title}
      label={title}
      size="lg"
      onClose={onClose}
      footnote={note}
      actions={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" disabled={busy || !name.trim()} onClick={submit}>
            {submitLabel}
          </Btn>
        </>
      }
    >
      <div className="space-y-4">
        {!kindLocked && (
          <Select label="设定类型" value={kind} onChange={(v) => setKind(v as CreativeKind)} options={Object.entries(kindLabels).filter(([value]) => !kinds || kinds.includes(value as CreativeKind)).map(([value, label]) => ({ value, label }))} />
        )}
        <label className="block text-ui-sm">
          名称
          <input aria-label="设定名称" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-paper px-3 py-2 text-ui text-ink" />
        </label>
        <label className="block text-ui-sm">
          别名（用顿号分隔）
          <input aria-label="别名" value={aliases} onChange={(e) => setAliases(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-paper px-3 py-2 text-ui text-ink" />
        </label>
        <label className="block text-ui-sm">
          概述
          <textarea aria-label="概述" maxLength={2000} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-paper px-3 py-2 font-prose text-ui text-ink" />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-ui-sm">属性</legend>
          {fields.map((f, i) => (
            <div key={i} className="flex gap-2">
              <input aria-label={`属性名 ${i + 1}`} placeholder="如：动机" maxLength={40} value={f.key} onChange={(e) => setFields((all) => all.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className="w-28 rounded-md border border-line bg-paper px-3 py-2 text-ui" />
              <input aria-label={`属性值 ${i + 1}`} maxLength={2000} value={f.value} onChange={(e) => setFields((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="min-w-0 flex-1 rounded-md border border-line bg-paper px-3 py-2 text-ui" />
              <Btn size="sm" ariaLabel={`删除属性 ${i + 1}`} onClick={() => setFields((all) => all.filter((_, j) => j !== i))}>
                删除
              </Btn>
            </div>
          ))}
          {fields.length < 20 && (
            <Btn size="sm" variant="outline" onClick={() => setFields((all) => [...all, { key: '', value: '' }])}>
              添加属性
            </Btn>
          )}
        </fieldset>
        {isPlan && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="计划章节" value={chapterId} onChange={setChapterId} options={chapterOptions} />
            {kind === 'foreshadowing' && <Select label="计划回收章节" value={payoffChapterId} onChange={setPayoffChapterId} options={chapterOptions} />}
          </div>
        )}
        {isPlan && <p className="text-micro text-ink-3">规划只表示作者意图，不代表正文已经发生。</p>}
        {showStatus && (
          <Select label="保存为" value={status} onChange={(v) => setStatus(v as 'draft' | 'accepted')} options={[{ value: 'accepted', label: '已确认设定' }, { value: 'draft', label: '草稿（尚未确定）' }]} />
        )}
        {error && (
          <p role="alert" className="text-ui-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
