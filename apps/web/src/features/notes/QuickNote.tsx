import { useRef, useState } from 'react'
import { Btn, Kbd, TextArea } from '../../components/vnext/ui'
import type { useNotes } from './useNotes'
export default function QuickNote({
  notes,
  chapterId,
  quote,
  onClose,
}: {
  notes: ReturnType<typeof useNotes>
  chapterId: string
  /** Selected prose shown for context only. It is not added to the note. */
  quote?: string
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [next, setNext] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const replay = useRef({ fingerprint: '', key: crypto.randomUUID() })
  const save = async () => {
    if (!text.trim() || busy) return
    const input = {
      content: text,
      chapterId: chapterId || null,
      purpose: next ? ('next_writing' as const) : ('note' as const),
    }
    const fingerprint = JSON.stringify(input)
    if (fingerprint !== replay.current.fingerprint)
      replay.current = { fingerprint, key: crypto.randomUUID() }
    setBusy(true)
    setError('')
    try {
      await notes.save(input, replay.current.key)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，输入已保留')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="dialog"
      aria-label="随手记"
      className="fade-up fixed bottom-6 left-1/2 z-40 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl bg-surface p-4 shadow-soft"
    >
      <fieldset disabled={busy}>
        {quote?.trim() && (
          <p className="mb-2 truncate border-l-2 border-ink-4 pl-2 font-prose text-ui-sm text-ink-3">
            {quote.trim()}
          </p>
        )}
        <TextArea
          label="随手记内容"
          prose
          autoFocus
          rows={2}
          value={text}
          onChange={setText}
          placeholder="记下这个念头。它只是笔记，不会变成设定。"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void save()
            }
            if (event.key === 'Escape' && !busy) onClose()
          }}
        />
        {error && (
          <p role="alert" className="mt-2 text-ui-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-micro text-ink-3">
          <Btn
            size="sm"
            variant={next ? 'outline' : 'quiet'}
            pressed={next}
            onClick={() => setNext(!next)}
          >
            标为“下次要写”
          </Btn>
          <span className="ml-auto hidden sm:inline">
            <Kbd>Enter</Kbd> 保存 · <Kbd>Esc</Kbd> 关闭
          </span>
          <Btn size="sm" onClick={onClose}>
            取消
          </Btn>
          <Btn
            size="sm"
            variant="primary"
            disabled={!text.trim() || busy}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '记下'}
          </Btn>
        </div>
      </fieldset>
    </div>
  )
}
