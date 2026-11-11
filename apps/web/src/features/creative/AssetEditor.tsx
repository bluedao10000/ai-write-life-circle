import { useState } from 'react'
import type { CreativeContent, CreativeKind } from '@writer-agent/contracts'
import { Btn, Dialog, Field, Heading, Icon, IconBtn, Select, TextArea } from '../../components/vnext/ui'
import { kindLabels } from './labels'

const planKinds: CreativeKind[] = ['plot_line', 'event', 'foreshadowing', 'character_arc']
const prompts: Partial<Record<CreativeKind, string>> = {
  character: '这个人是谁？他想要什么，又被什么牵绊？',
  character_arc: '他从哪里出发，经历什么，最终如何改变？',
  world_rule: '这个世界如何运作？规则的边界是什么？',
  place: '这里是什么地方，与故事有什么关系？',
  organization: '谁聚在这里，他们共同追求什么？',
  event: '发生了什么，带来了什么变化？',
  plot_line: '这条故事线的起点、冲突与走向。',
  foreshadowing: '想埋下什么线索，期待它如何呼应？',
  open_question: '还有哪个问题需要继续想一想？',
}

export type EditorResult = { kind: CreativeKind; content: CreativeContent; status: 'draft' | 'accepted' }

/** Shapes author edits; persistence and version checks belong to the caller. */
export default function AssetEditor({
  title, initial, kind: initialKind, kindLocked, kinds, showStatus, submitLabel, chapters, busy, error, note, onSubmit, onClose,
}: {
  title: string
  initial?: CreativeContent
  kind?: CreativeKind
  kindLocked?: boolean
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
  const [kind, setKind] = useState<CreativeKind>(initialKind ?? kinds?.[0] ?? 'character')
  const [name, setName] = useState(initial?.name ?? '')
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join('、'))
  const [summary, setSummary] = useState(initial?.summary ?? '')
  const [fields, setFields] = useState(initial?.fields?.length ? initial.fields : [{ key: '', value: '' }])
  const [chapterId, setChapterId] = useState(initial?.plan?.chapterId ?? '')
  const [payoffChapterId, setPayoffChapterId] = useState(initial?.plan?.payoffChapterId ?? '')
  const [status, setStatus] = useState<'draft' | 'accepted'>('accepted')
  const [questionStatus, setQuestionStatus] = useState<NonNullable<CreativeContent['questionStatus']>>(initial?.questionStatus ?? 'pending')
  const isPlan = planKinds.includes(kind)
  const submit = () => {
    if (busy || !name.trim()) return
    const plan = isPlan && (chapterId || (kind === 'foreshadowing' && payoffChapterId)) ? {
      ...(chapterId ? { chapterId } : {}),
      ...(kind === 'foreshadowing' && payoffChapterId ? { payoffChapterId } : {}),
    } : undefined
    onSubmit({
      kind,
      status,
      content: {
        name: name.trim(),
        aliases: aliases.split(/[,，、]/).map((value) => value.trim()).filter(Boolean),
        summary: summary.trim(),
        fields: fields.map((field) => ({ key: field.key.trim(), value: field.value.trim() })).filter((field) => field.key && field.value),
        ...(plan ? { plan } : {}),
        ...(kind === 'open_question' ? { questionStatus } : {}),
      },
    })
  }
  const close = () => { if (!busy) onClose() }
  const chapterOptions = [{ value: '', label: '不锚定章节' }, ...chapters.map((chapter) => ({ value: chapter.id, label: chapter.title }))]
  const optionsFor = (id: string) => id && !chapters.some((chapter) => chapter.id === id) ? [...chapterOptions, { value: id, label: '原计划章节已不在目录中' }] : chapterOptions

  return (
    <Dialog title={<span className="flex items-center gap-2"><Icon name="edit" className="text-ink-3" />{title}</span>} label={title} size="lg" onClose={close} footnote={note} actions={<><Btn disabled={busy} onClick={close}>取消</Btn><Btn variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>{busy ? '正在保存…' : submitLabel}</Btn></>}>
      <div className="space-y-6">
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          <legend className="sr-only">设定内容</legend>
          {!kindLocked && <Select label="设定类型" value={kind} onChange={(value) => setKind(value as CreativeKind)} options={Object.entries(kindLabels).filter(([value]) => !kinds || kinds.includes(value as CreativeKind)).map(([value, label]) => ({ value, label }))} />}
          <Field label="设定名称" maxLength={80} value={name} onChange={setName} autoFocus placeholder={`为${kindLabels[kind]}起一个名字`} />
          <Field label="别名" value={aliases} onChange={setAliases} placeholder="多个别名用顿号分隔" />
          <label className="block">
            <span className="mb-1.5 block text-ui-sm text-ink-2">概述</span>
            <TextArea label="概述" maxLength={2000} rows={4} value={summary} onChange={setSummary} placeholder={prompts[kind] ?? '记下这条设定的核心内容。'} prose className="border border-line bg-page px-3 py-2" />
          </label>
        </fieldset>
        <fieldset disabled={busy} className="min-w-0 border-t border-line-soft pt-4">
          <legend className="sr-only">设定属性</legend>
          <div className="mb-3 flex items-baseline justify-between gap-3"><Heading level={3}>属性</Heading><span className="text-micro text-ink-3">按你的方式记录 · {fields.length} / 20</span></div>
          <div className="space-y-2">
            {fields.map((field, index) => <div key={index} className="flex items-start gap-2">
              <Field label={`属性名 ${index + 1}`} hideLabel placeholder={kind === 'character' ? '如：动机' : '属性名'} maxLength={40} value={field.key} onChange={(value) => setFields((all) => all.map((item, position) => position === index ? { ...item, key: value } : item))} className="w-24 shrink-0 sm:w-28" />
              <TextArea label={`属性值 ${index + 1}`} rows={2} maxLength={2000} placeholder="记下具体内容" value={field.value} onChange={(value) => setFields((all) => all.map((item, position) => position === index ? { ...item, value } : item))} className="min-w-0 flex-1 border border-line bg-page px-3 py-2" />
              <IconBtn size="sm" icon="x" label={`删除属性 ${index + 1}`} disabled={busy} onClick={() => setFields((all) => all.filter((_, position) => position !== index))} className="mt-1.5" />
            </div>)}
          </div>
          {fields.length < 20 && <Btn size="sm" variant="quiet" disabled={busy} className="mt-2 -ml-2" onClick={() => setFields((all) => [...all, { key: '', value: '' }])}><Icon name="plus" className="h-3 w-3" />添加属性</Btn>}
        </fieldset>
        {isPlan && <fieldset disabled={busy} className="min-w-0 space-y-3 border-t border-line-soft pt-4">
          <legend className="sr-only">章节规划</legend><Heading level={3}>章节规划</Heading>
          <div className="grid gap-3 sm:grid-cols-2"><Select label="计划章节" value={chapterId} onChange={setChapterId} options={optionsFor(chapterId)} />{kind === 'foreshadowing' && <Select label="计划回收章节" value={payoffChapterId} onChange={setPayoffChapterId} options={optionsFor(payoffChapterId)} />}</div>
          <p className="text-micro text-ink-3">这是创作安排，不代表正文已经发生。</p>
        </fieldset>}
        {kind === 'open_question' && <fieldset disabled={busy}><Select label="问题状态" value={questionStatus} onChange={(value) => setQuestionStatus(value as typeof questionStatus)} options={[{ value: 'pending', label: '待讨论' }, { value: 'deferred', label: '暂缓' }, { value: 'resolved', label: '已解决' }]} /></fieldset>}
        {showStatus && <fieldset disabled={busy} className="border-t border-line-soft pt-4"><Select label="保存为" value={status} onChange={(value) => setStatus(value as 'draft' | 'accepted')} options={[{ value: 'accepted', label: '已确认设定' }, { value: 'draft', label: '草稿（尚未确定）' }]} /></fieldset>}
        {error && <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-ui-sm text-danger"><Icon name="alert" className="mt-0.5" />{error}</p>}
      </div>
    </Dialog>
  )
}
