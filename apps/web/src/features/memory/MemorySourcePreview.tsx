import { useEffect, useRef, useState } from 'react'
import { Btn } from '../../components/vnext/ui'
import { proceduralMemoryApi as api, type MemorySource } from '../../services/api/proceduralMemoryApi'
import { ApiProblemError } from '../../services/writerAgent'

export default function MemorySourcePreview({ bookId, taskId }: { bookId: string; taskId: string }) {
  const [source, setSource] = useState<MemorySource | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [bookId, taskId])
  async function open() {
    request.current?.abort()
    if (source) { setSource(null); return }
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setError('')
    try {
      const value = await api.source(bookId, taskId, controller.signal)
      if (!controller.signal.aborted) setSource(value)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof ApiProblemError && (error.status === 404 || error.status === 410) ? '原始来源已删除或不再保留，无法预览。' : '暂时无法读取来源，请重试。')
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }
  return <div className="space-y-2 text-ui-sm">
    <Btn disabled={loading} ariaLabel={`${source ? '收起' : '查看'}任务 ${taskId} 的原始来源`} onClick={() => void open()}>{loading ? '正在读取来源…' : source ? '收起来源' : '查看原始来源'}</Btn>
    {error && <p role="alert" className="text-warn">{error}</p>}
    {source && <div role="region" aria-label="原始任务来源" className="max-h-72 space-y-2 overflow-auto rounded border border-line-soft p-3">
      <p className="text-ink-3">{source.source.type === 'chapter' ? '任务关联章节的原始版本。' : '任务关联讨论的原始摘录。'}可用于核对经验的适用情境。</p>
      {source.source.type === 'chapter' ? <>
        <p className="break-all text-micro text-ink-3">章节 {source.source.chapterId} · 版本 {source.source.revisionId}</p>
        <p className="whitespace-pre-wrap break-words">{source.source.text || '该来源正文为空。'}</p>
      </> : source.source.messages.map(message => <div key={message.messageId}>
        <p className="text-ink-3">{message.role === 'user' ? '作者' : '助手建议'}</p>
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
      </div>)}
      {source.truncated && <p role="status" className="text-ink-3">来源较长，此处仅显示开头部分。</p>}
    </div>}
  </div>
}
