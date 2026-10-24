import { useEffect, useState } from 'react'
import type { WriterAgentAdapter } from '../../services/writerAgent'
import { Btn, Dialog, Icon } from '../../components/vnext/ui'

/** A read-only server preview. Loading it never discards or replaces the author's draft. */
export default function SaveConflictDialog({
  adapter,
  projectId,
  chapterId,
  localMarkdown,
  onExport,
  onKeep,
  onUseServer,
}: {
  adapter: WriterAgentAdapter
  projectId: string
  chapterId: string
  localMarkdown: string
  onExport: () => void
  onKeep: () => void
  onUseServer: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [server, setServer] = useState<{ markdown: string; savedAt?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!expanded || adapter.mode !== 'api') return
    let active = true
    setLoading(true)
    setError('')
    setServer(null)
    void adapter
      .loadChapter(projectId, chapterId)
      .then((detail) => {
        if (active)
          setServer({
            markdown: detail.headRevision.markdown,
            savedAt: detail.headRevision.createdAt,
          })
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '服务器版本读取失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [adapter, projectId, chapterId, expanded])
  return (
    <Dialog
      label="保存冲突"
      wide={expanded}
      onClose={onKeep}
      title={
        <span className="flex items-center gap-2 text-danger">
          <Icon name="alert" />
          这一章在别处被保存过
        </span>
      }
      actions={
        <>
          <Btn disabled title="尚未实现逐段合并">
            版本对比（规划中）
          </Btn>
          <Btn onClick={onUseServer}>使用服务器版本…</Btn>
          <Btn variant="outline" onClick={onExport}>
            <Icon name="download" />
            导出本地草稿
          </Btn>
          <Btn variant="primary" onClick={onKeep}>
            保留本地草稿，稍后处理
          </Btn>
        </>
      }
    >
      <p>为避免覆盖，自动保存已暂停。当前输入仍保留，查看服务器版本不会替换正文。</p>
      <Btn variant="link" className="mt-3" onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起服务器版本' : '查看服务器版本'}
      </Btn>
      {expanded && (
        <>
          {loading && (
            <p role="status" className="mt-4">
              正在读取服务器版本…
            </p>
          )}
          {error && (
            <p role="alert" className="mt-4 text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            <section>
              <h3 className="mb-2 text-micro text-ink-3">本地草稿（当前窗口）</h3>
              <pre className="scroll max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-prose text-ui whitespace-pre-wrap">
                {localMarkdown}
              </pre>
            </section>
            <section>
              <h3 className="mb-2 text-micro text-ink-3">
                服务器版本
                {server?.savedAt ? ` · ${new Date(server.savedAt).toLocaleString('zh-CN')}` : ''}
              </h3>
              <pre className="scroll max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-prose text-ui whitespace-pre-wrap">
                {server?.markdown ?? ''}
              </pre>
            </section>
          </div>
        </>
      )}
    </Dialog>
  )
}
