import { useRef, useState } from 'react'
import type { AuthorNote, Chapter, NoteCreate } from '@writer-agent/contracts'
import { Btn, Dialog, Heading, Select, TextArea, ago } from '../../components/vnext/ui'
import type { useNotes } from './useNotes'

type Props = {
  notes: ReturnType<typeof useNotes>
  chapters: Chapter[]
  currentChapterId: string
  enabled: boolean
  demo: boolean
  onClose: () => void
  onPropose?: (note: AuthorNote) => void
}

export function NotesPanel({
  notes,
  chapters,
  currentChapterId,
  enabled,
  demo,
  onClose,
  onPropose,
}: Props) {
  const [content, setContent] = useState('')
  const [chapterId, setChapterId] = useState(currentChapterId)
  const [purpose, setPurpose] = useState<NoteCreate['purpose']>('note')
  const [editing, setEditing] = useState<AuthorNote | null>(null)
  const [compose, setCompose] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [archived, setArchived] = useState(false)
  const [pendingOpen, setPendingOpen] = useState<AuthorNote | 'new' | null>(null)
  const retry = useRef<{ fingerprint: string; key: string } | null>(null)
  const dirty =
    content !== (editing?.content ?? '') ||
    (editing !== null && (chapterId !== (editing.chapterId ?? '') || purpose !== editing.purpose))
  const save = async (status: AuthorNote['status'] = 'active') => {
    if (saving || !content.trim()) return
    setSaving(true)
    setError('')
    setMessage('')
    const input = {
      content,
      chapterId: chapterId || null,
      purpose,
      ...(editing ? { baseVersion: editing.version, status } : {}),
    }
    const fingerprint = JSON.stringify([editing?.noteId, input])
    if (retry.current?.fingerprint !== fingerprint)
      retry.current = { fingerprint, key: crypto.randomUUID() }
    try {
      await notes.save(input, retry.current.key, editing?.noteId)
      setContent('')
      setEditing(null)
      setCompose(false)
      retry.current = null
      setMessage(status === 'archived' ? '笔记已归档' : '笔记已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，输入仍保留。')
    } finally {
      setSaving(false)
    }
  }
  const open = (note: AuthorNote | 'new') => {
    setEditing(note === 'new' ? null : note)
    setContent(note === 'new' ? '' : note.content)
    setChapterId(note === 'new' ? currentChapterId : (note.chapterId ?? ''))
    setPurpose(note === 'new' ? 'note' : note.purpose)
    setError('')
    setMessage('')
    setCompose(true)
    retry.current = null
  }
  const requestOpen = (note: AuthorNote | 'new') => {
    if (dirty) setPendingOpen(note)
    else open(note)
  }
  const list = notes.items
    .filter((note) => (note.status === 'archived') === archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return (
    <section aria-label="创作笔记">
      <Heading level={1}>创作笔记{demo ? ' · 演示' : ''}</Heading>
      <p className="mt-2 mb-8 text-ui text-ink-3">
        念头、疑问和结论。笔记不是设定，不需要审批，也不会被 AI 当作作品事实。
      </p>
      {!enabled ? (
        <p className="text-ui text-ink-3">
          笔记功能尚未接入。服务器未声明此能力，不会使用演示数据代替。
        </p>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap gap-2">
            <Btn
              size="sm"
              variant={archived ? 'quiet' : 'outline'}
              onClick={() => setArchived(false)}
            >
              进行中
            </Btn>
            <Btn
              size="sm"
              variant={archived ? 'outline' : 'quiet'}
              onClick={() => setArchived(true)}
            >
              已归档
            </Btn>
            <Btn size="sm" className="ml-auto" disabled={saving} onClick={() => requestOpen('new')}>
              添加笔记
            </Btn>
            <Btn size="sm" disabled={saving || notes.loading} onClick={() => void notes.reload()}>
              重新读取笔记
            </Btn>
          </div>
          <p role="status" className="mb-3 text-ui-sm text-ink-3">
            {message || (notes.loading ? '正在读取笔记…' : '')}
          </p>
          {notes.error && (
            <p role="alert" className="mb-4 text-ui text-danger">
              {notes.error}
            </p>
          )}
          {compose && (
            <form
              className="mb-10 space-y-4 rounded-lg bg-surface p-4"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <Heading level={3}>{editing ? '编辑笔记' : '记下一个念头'}</Heading>
              <TextArea
                label="笔记内容"
                value={content}
                disabled={saving}
                maxLength={20000}
                onChange={(value) => {
                  setContent(value)
                  setMessage('')
                }}
                prose
                rows={5}
              />
              <Select
                label="关联章节"
                value={chapterId}
                disabled={saving}
                onChange={setChapterId}
                options={[
                  { value: '', label: '不关联章节' },
                  ...chapters.map((chapter) => ({ value: chapter.id, label: chapter.title })),
                ]}
              />
              <Select
                label="笔记用途"
                value={purpose}
                disabled={saving}
                onChange={(value) => setPurpose(value === 'next_writing' ? 'next_writing' : 'note')}
                options={[
                  { value: 'note', label: '普通笔记' },
                  { value: 'next_writing', label: '下次要写' },
                ]}
              />
              {error && (
                <p role="alert" className="text-ui-sm text-danger">
                  {error} 当前输入未清除。
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Btn
                  variant="primary"
                  disabled={saving || !content.trim()}
                  onClick={() => void save()}
                >
                  {saving ? '保存笔记中…' : editing ? '保存笔记修改' : '保存笔记'}
                </Btn>
                {editing && (
                  <Btn
                    disabled={saving}
                    onClick={() => void save(editing.status === 'archived' ? 'active' : 'archived')}
                  >
                    {editing.status === 'archived' ? '恢复笔记' : '归档笔记'}
                  </Btn>
                )}
                {editing && (
                  <Btn
                    variant="outline"
                    disabled={saving || dirty || !onPropose}
                    title={!onPropose ? '正式设定变更流程尚未接入' : '演示候选，不修改真实知识'}
                    onClick={() => onPropose?.(editing)}
                  >
                    这是一个设定变更…{!onPropose ? '（尚未接入）' : ''}
                  </Btn>
                )}
                <Btn onClick={onClose}>回到正文</Btn>
              </div>
            </form>
          )}
          <ul className="space-y-8">
            {list.map((note) => (
              <li key={note.noteId} className="border-l-2 border-ink-4 pl-4">
                <button
                  type="button"
                  disabled={saving}
                  className="btn block w-full text-left"
                  onClick={() => requestOpen(note)}
                >
                  <span className="block whitespace-pre-wrap break-words font-prose text-read text-ink">
                    {note.content}
                  </span>
                  <span className="mt-1.5 block text-micro text-ink-3">
                    {note.purpose === 'next_writing' ? '下次要写 · ' : ''}
                    {chapters.find((chapter) => chapter.id === note.chapterId)?.title ??
                      '未关联章节'}{' '}
                    · {ago(Date.parse(note.updatedAt))}
                  </span>
                </button>
              </li>
            ))}
            {!notes.loading && !notes.error && list.length === 0 && (
              <li className="text-ui text-ink-3">
                {archived ? '没有归档的笔记。' : '还没有笔记。写作时按 ⌘; 随手记下。'}
              </li>
            )}
          </ul>
        </>
      )}
      {pendingOpen && (
        <Dialog
          title="放弃当前尚未保存的笔记输入？"
          label="切换笔记"
          onClose={() => setPendingOpen(null)}
          actions={
            <>
              <Btn onClick={() => setPendingOpen(null)}>继续编辑</Btn>
              <Btn
                variant="danger"
                onClick={() => {
                  open(pendingOpen)
                  setPendingOpen(null)
                }}
              >
                放弃并打开
              </Btn>
            </>
          }
        >
          当前输入还没有保存。保存后再切换可以保留这些想法。
        </Dialog>
      )}
    </section>
  )
}
