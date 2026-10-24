import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportPreview, ManagedBook } from '@writer-agent/contracts'
import { Btn, Icon } from '../../components/vnext/ui'
import type { BookManagementAdapter } from '../../services/writerAgent'

type Props = {
  adapter: BookManagementAdapter
  onComplete: (book: ManagedBook) => void
  onCancel: () => void
}

export default function EPUBImportDialog({ adapter, onComplete, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [fileTooLarge, setFileTooLarge] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [title, setTitle] = useState('')
  const [volumes, setVolumes] = useState<ImportPreview['volumes']>([])
  const [chapters, setChapters] = useState<ImportPreview['chapters']>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uploadKey, setUploadKey] = useState('')
  const [commitKey, setCommitKey] = useState('')
  const submittedCommit = useRef('')

  const resetPreview = () => {
    setFileTooLarge(false)
    setPreview(null)
    setTitle('')
    setVolumes([])
    setChapters([])
    setError('')
    setUploadKey('')
    setCommitKey('')
    submittedCommit.current = ''
  }
  const discardPreview = () => {
    if (preview && preview.status !== 'committed' && adapter.deleteImport) {
      void adapter.deleteImport(preview.importId).catch(() => undefined)
    }
    resetPreview()
  }
  const choose = async (next: File | null) => {
    if (next && next.size > 64 * 1024 * 1024) {
      if (preview && adapter.deleteImport) {
        void adapter.deleteImport(preview.importId).catch(() => undefined)
      }
      setFile(next)
      setFileTooLarge(true)
      setPreview(null)
      setTitle('')
      setVolumes([])
      setChapters([])
      setUploadKey('')
      setCommitKey('')
      submittedCommit.current = ''
      setError('EPUB 文件超过 64 MiB 上限。')
      return
    }
    setFile(next)
    setFileTooLarge(false)
    if (preview && adapter.deleteImport) {
      void adapter.deleteImport(preview.importId).catch(() => undefined)
    }
    resetPreview()
  }
  const upload = async () => {
    if (!file || fileTooLarge || !adapter.uploadEPUB || busy) return
    setBusy(true)
    setError('')
    try {
      const key = uploadKey || crypto.randomUUID()
      setUploadKey(key)
      const result = await adapter.uploadEPUB(file, key)
      setPreview(result)
      setTitle(result.title)
      setVolumes(result.volumes)
      setChapters(result.chapters)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'EPUB 解析失败。')
    } finally {
      setBusy(false)
    }
  }
  const commit = async () => {
    if (!preview || !adapter.commitImport || busy) return
    setBusy(true)
    setError('')
    try {
      const key = submittedCommit.current || commitKey || crypto.randomUUID()
      setCommitKey(key)
      submittedCommit.current = key
      const book = await adapter.commitImport(
        preview.importId,
        {
          fingerprint: preview.fingerprint,
          title,
          volumes,
          chapters: chapters.map((chapter) => ({
            chapterId: chapter.chapterId,
            title: chapter.title,
            ...(chapter.volumeId ? { volumeId: chapter.volumeId } : {}),
          })),
        },
        key,
      )
      onComplete(book)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '作品导入失败。')
    } finally {
      setBusy(false)
    }
  }
  const cancel = useCallback(() => {
    // Once commit succeeds, the staged import is server-owned history and
    // cannot be deleted. onComplete closes the dialog, so only pre-commit
    // previews use this cleanup path.
    if (preview && preview.status !== 'committed' && adapter.deleteImport) {
      void adapter.deleteImport(preview.importId).catch(() => undefined)
    }
    onCancel()
  }, [adapter, onCancel, preview])
  const updateTitle = (value: string) => {
    setTitle(value)
    setCommitKey('')
    submittedCommit.current = ''
  }
  const updateVolume = (volumeId: string, value: string) => {
    setVolumes((current) => current.map((volume) => (
      volume.volumeId === volumeId ? { ...volume, title: value } : volume
    )))
    setCommitKey('')
    submittedCommit.current = ''
  }
  const updateChapter = (chapterId: string, value: string) => {
    setChapters((current) => current.map((chapter) => (
      chapter.chapterId === chapterId ? { ...chapter, title: value } : chapter
    )))
    setCommitKey('')
    submittedCommit.current = ''
  }
  const words = preview?.chapters.reduce((total, chapter) => total + chapter.wordCount, 0) ?? 0

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, cancel])

  return (
    <div
      className="fade fixed inset-0 z-50 flex items-end justify-center bg-scrim p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="epub-import-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) cancel()
      }}
    >
      <section className="fade-up flex max-h-[min(760px,100dvh)] w-full flex-col rounded-t-xl border border-line bg-surface shadow-soft sm:max-h-[min(760px,calc(100vh-2rem))] sm:w-[min(720px,100%)] sm:rounded-xl">
        <header className="px-6 pt-6 pb-4">
          <h2 id="epub-import-title" className="font-prose text-h2 font-medium text-ink">
            从 EPUB 导入作品
          </h2>
          <p className="mt-2 text-ui text-ink-2">
            先还原原文与目录。<span className="text-ink">导入不会调用模型，也不会发送正文。</span>
          </p>
        </header>
        <div className="scroll min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {error && (
            <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-danger bg-danger-soft px-4 py-3 text-ui text-danger">
              <Icon name="alert" className="mt-0.5" />
              <span className="min-w-0">{error}</span>
            </div>
          )}
          {!preview ? (
            <div className="grid gap-4">
              <label className="grid cursor-pointer gap-2 rounded-xl border border-dashed border-line px-6 py-8 text-center transition-colors hover:bg-surface-2 focus-within:border-ink-3">
                <Icon name={file ? 'file' : 'upload'} className="mx-auto text-ink-3" />
                <span className="text-ui text-ink">{file ? file.name : '选择 EPUB 小说'}</span>
                <span className="text-ui-sm text-ink-3">
                  支持文本型 EPUB 2/3；单文件最大 64 MiB，最多 2000 章。
                </span>
                <input
                  className="mx-auto mt-2 block max-w-full text-ui-sm text-ink-2 file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-ui file:text-ink"
                  type="file"
                  accept=".epub,application/epub+zip"
                  disabled={busy}
                  onChange={(event) => void choose(event.target.files?.[0] ?? null)}
                />
              </label>
              {busy && (
                <div role="status" aria-live="polite" className="rounded-xl border border-line p-4">
                  <div className="flex items-center gap-3 text-ui text-ink">
                    <Icon name="file" className="text-ink-3" />
                    <span className="min-w-0 flex-1 truncate">{file?.name}</span>
                    <span className="text-micro text-ink-3">正在安全解析…</span>
                  </div>
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="bar-indeterminate h-full w-2/5 rounded-full bg-accent" />
                  </div>
                  <p className="mt-3 text-ui-sm text-ink-3">离开或取消会放弃本次解析，不会创建作品。</p>
                </div>
              )}
              <ul className="grid gap-1 text-ui-sm text-ink-2">
                <li>· 保留目录中的卷、章与阅读顺序。</li>
                <li>· 只提取正文、标题和基础强调，不自动润色。</li>
                <li>· DRM、固定版式与无法定位的章节会明确拒绝或警告。</li>
                <li>· 导入后知识库仍等待你在“书”页面明确授权。</li>
              </ul>
            </div>
          ) : (
            <div className="grid gap-5">
              <div className="flex items-center gap-1.5 text-ui-sm text-ok"><Icon name="check" />解析完成</div>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="章节" value={String(preview.chapters.length)} />
                <Stat label="卷" value={String(preview.volumes.length)} />
                <Stat label="字数" value={words.toLocaleString('zh-CN')} />
              </div>
              <label className="grid gap-1">
                <span className="text-ui-sm text-ink-2">作品名称</span>
                <input
                  className="rounded-md border border-line bg-page px-3 py-2 font-prose text-ui-lg text-ink outline-none focus:border-ink-3"
                  maxLength={200}
                  value={title}
                  disabled={busy}
                  onChange={(event) => updateTitle(event.target.value)}
                />
              </label>
              {volumes.length > 0 && (
                <details className="rounded-xl border border-line p-3">
                  <summary className="cursor-pointer text-ui text-ink">检查卷名（可选）</summary>
                  <div className="mt-3 grid gap-2">
                    {volumes.map((volume) => (
                      <label key={volume.volumeId} className="grid gap-1">
                        <span className="text-ui-sm text-ink-3">卷名</span>
                        <input
                          aria-label={`卷名 ${volume.title}`}
                          className="rounded-md border border-line bg-page px-3 py-1.5 font-prose text-ui text-ink outline-none focus:border-ink-3"
                          maxLength={200}
                          value={volume.title}
                          disabled={busy}
                          onChange={(event) => updateVolume(volume.volumeId, event.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                </details>
              )}
              {preview.warnings.length > 0 && (
                <div className="rounded-xl border border-warn bg-warn-soft px-4 py-3">
                  <div className="flex items-center gap-2 text-ui text-ink"><Icon name="info" className="text-warn" />解析警告</div>
                  <ul className="mt-2 grid list-disc gap-1 pl-6 text-ui-sm text-ink-2">
                    {preview.warnings.map((warning) => (
                      <li key={warning.code}>
                        {warning.message}（{warning.code}）
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-ui-lg font-medium text-ink">目录预览</h3>
                  <span className="text-ui-sm text-ink-3">
                    最多显示前 200 章
                  </span>
                </div>
                <ol className="scroll max-h-72 overflow-y-auto rounded-xl border border-line">
                  {chapters.slice(0, 200).map((chapter, index) => {
                    const volume = volumes.find(
                      (item) => item.volumeId === chapter.volumeId,
                    )
                    return (
                      <li key={chapter.chapterId} className="border-b border-line-soft px-4 py-2.5 last:border-b-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <label className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="font-mono-num w-8 shrink-0 text-micro text-ink-3">{index + 1}.</span>
                            <span className="sr-only">章名 {index + 1}</span>
                            <input
                              aria-label={`章名 ${index + 1}`}
                              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 font-prose text-ui text-ink outline-none hover:border-line focus:border-ink-3 focus:bg-page"
                              maxLength={200}
                              value={chapter.title}
                              disabled={busy}
                              onChange={(event) => updateChapter(chapter.chapterId, event.target.value)}
                            />
                          </label>
                          <span className="font-mono-num shrink-0 text-micro text-ink-3">
                            {chapter.wordCount.toLocaleString('zh-CN')} 字
                          </span>
                        </div>
                        <div className="mt-0.5 truncate pl-10 text-ui-sm text-ink-3">
                          {volume ? `${volume.title} · ` : ''}
                          {chapter.excerpt}
                        </div>
                      </li>
                    )
                  })}
                </ol>
                {chapters.length > 200 && (
                  <p className="mt-2 text-ui-sm text-ink-3">
                    其余 {chapters.length - 200} 章会完整导入并保留解析标题。
                  </p>
                )}
              </div>
              <p className="rounded-lg bg-surface-2 px-4 py-3 text-ui-sm text-ink-2">
                确认后会一次性保存全部章节的原始 Revision，再把完整作品加入书架。知识构建尚未开始。
              </p>
            </div>
          )}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 border-t border-line-soft px-6 py-4">
          <Btn variant="outline" disabled={busy} onClick={cancel}>
            取消
          </Btn>
          {preview ? (
            <>
              <Btn
                disabled={busy}
                onClick={discardPreview}
              >
                重新选择
              </Btn>
              <Btn
                variant="primary"
                disabled={
                  busy ||
                  title.trim() === '' ||
                  volumes.some((volume) => volume.title.trim() === '') ||
                  chapters.some((chapter) => chapter.title.trim() === '')
                }
                onClick={() => void commit()}
              >
                {busy ? '正在完整导入…' : '确认导入作品'}
              </Btn>
            </>
          ) : (
            <Btn
              variant="primary"
              disabled={busy || !file || fileTooLarge}
              onClick={() => void upload()}
            >
              {busy ? '正在安全解析…' : '解析并预览'}
            </Btn>
          )}
        </footer>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-2 py-2.5 text-center">
      <div className="text-micro text-ink-3">{label}</div>
      <div className="font-mono-num mt-0.5 text-ui-lg text-ink">{value}</div>
    </div>
  )
}
