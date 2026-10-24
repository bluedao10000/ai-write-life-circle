import { useState } from 'react'
import type { AuthorNote } from '@writer-agent/contracts'
import type { CanonChange, Entry, CanonCandidateContext } from './model'
import { Btn, Dialog, Select, TextArea } from '../../components/vnext/ui'

/** Explicit Demo-only candidate construction; cannot write to the real Harness. */
export default function CanonCandidate({
  note,
  context,
  entries,
  onCreate,
  onClose,
}: {
  note: AuthorNote | null
  context?: CanonCandidateContext | null
  entries: Entry[]
  onCreate: (candidate: CanonChange) => void
  onClose: () => void
}) {
  const [entryId, setEntryId] = useState(context?.entryId ?? entries[0]?.id ?? '')
  const [proposed, setProposed] = useState(note?.content ?? '')
  const entry = entries.find((value) => value.id === entryId)
  return (
    <Dialog
      label="起草定稿变更演示"
      title="起草定稿变更 · 演示"
      wide
      onClose={onClose}
      actions={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn
            variant="primary"
            disabled={!entry || !proposed.trim()}
            onClick={() => {
              if (!entry) return
              onCreate({
                id: crypto.randomUUID(),
                noteId: note?.noteId,
                entryId,
                field: '条目描述',
                current: entry.summary,
                proposed,
                reason: context?.reason ?? '由作者从创作笔记明确发起的演示候选',
                sources:
                  context?.sources ??
                  (note ? [{ label: '你的创作笔记', quote: note.content, state: 'ok' }] : []),
                chapters: entry.chapters,
                impact: ['影响分析尚未接入。请作者自行核对相关章节。'],
                status: 'draft',
              })
            }}
          >
            查看候选差异
          </Btn>
        </>
      }
    >
      <p className="mb-4">这里只更新独立的演示条目。真实正式设定审批与写入尚未接入。</p>
      <Select
        label="目标条目"
        value={entryId}
        onChange={setEntryId}
        options={entries.map((entry) => ({ value: entry.id, label: entry.name }))}
      />
      <div className="mt-6 text-micro text-ink-3">现有内容</div>
      <p className="mt-2 font-prose text-read">{entry?.summary ?? '尚无目标条目'}</p>
      <div className="mt-6 mb-2 text-micro text-ink-3">候选变更</div>
      <TextArea label="候选变更内容" value={proposed} onChange={setProposed} rows={4} prose />
    </Dialog>
  )
}
