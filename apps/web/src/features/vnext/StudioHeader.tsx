import { useState } from 'react'
import BookMenu from '../management/BookMenu'
import { useManagement } from '../management/ManagedStudio'
import type { useStudioController } from '../vnext/useStudioController'
import { Btn, Icon, IconBtn, Seg, Proto } from '../../components/vnext/ui'
import KnowledgeChip from '../knowledge/KnowledgeChip'
import AccountMeter from '../account/AccountMeter'
import { useKnowledgeSummary } from '../knowledge/useKnowledgeSummary'
import { RevisionHistory } from '../workspace/ComposeBar'

/**
 * Top bar from Figma Make App.tsx: menu · story2u / work · centred 灵感/阅读/书 ·
 * save status · 写作/阅读 toggle · focus · knowledge · theme · 发布. Chrome recedes
 * in focus mode; data-safety status never fades.
 */
export default function StudioHeader({ studio, demo }: { studio: ReturnType<typeof useStudioController>; demo: boolean }) {
  const management = useManagement()
  // Real data only: the chip needs a managed book and the API mode. Demo never shows it.
  const knowledge = useKnowledgeSummary(management?.book.bookId, !demo && !!management)
  const [history, setHistory] = useState(false)
  const { view, setView, setBookNav, setSaveDialog, workspace, chapter, layout, setLayout, dark, setDark, saveState, downloadLocalDraft, pinned, readonly, status, compose, typewriter, toggleTypewriter } = studio
  const focus = layout.focus && compose
  const hide = focus ? 'opacity-0 hover:opacity-100 focus-within:opacity-100' : ''
  const publicSite = import.meta.env.VITE_STORY2U_PUBLIC_SITE === 'true'
  const loaded = workspace.chapterLoadState.status === 'loaded' && !!chapter.id
  const publish = () => {
    void (async () => {
      try {
        if (management) await workspace.prepareStructure()
        else if (workspace.current) await workspace.prepareReview(workspace.current)
        window.location.assign('/studio/publish?book=' + encodeURIComponent(management?.book.bookId ?? (import.meta.env.VITE_WRITER_AGENT_PROJECT_ID || 'local')))
      } catch {
        studio.toast('正文尚未安全保存，发布未开始。请先处理保存问题。')
      }
    })()
  }
  return (
    <>
      <header className="relative z-40 flex h-12 shrink-0 items-center gap-1 px-2 sm:px-3">
        <div className={`chrome flex min-w-0 items-center gap-1 ${hide}`}>
          {view === 'read' && <IconBtn icon="menu" label="目录与本章相关" shortcut="⌘⇧E" active={layout.leftOpen} onClick={() => setLayout((l) => ({ ...l, leftOpen: !l.leftOpen }))} />}
          {publicSite && (
            <>
              <Btn
                size="sm"
                variant="quiet"
                // max-md:hidden: a plain `hidden` loses to the button's own inline-flex.
                className="font-prose max-md:hidden"
                title="story2u 公开站点"
                onClick={() => {
                  if (window.confirm('返回 story2u 前请确认草稿已保存。')) window.location.assign('/')
                }}
              >
                story2u
              </Btn>
              <span className="hidden text-ink-4 md:inline" aria-hidden>
                /
              </span>
            </>
          )}
          <div className="min-w-0 max-w-32 sm:max-w-60">{management ? <BookMenu /> : <span className="hidden truncate pl-1 font-prose text-ui text-ink-2 md:inline">{workspace.projectTitle}</span>}</div>
        </div>
        <div className={`chrome mx-auto md:absolute md:left-1/2 md:mx-0 md:-translate-x-1/2 ${hide}`}>
          <Seg label="主导航" value={view} onChange={setView} options={[['inspire', '灵感'], ['read', '阅读'], ['book', '书']]} />
        </div>
        <div className="flex items-center gap-1 md:ml-auto">
          {(pinned || (view === 'read' && chapter.id)) && (
            // Data-safety states never fade and never rely on colour alone (icon + text).
            <span role="status" aria-live="polite" className={`mr-1 items-center gap-1.5 text-ui-sm ${readonly ? 'inline-flex text-ink-2' : pinned ? `inline-flex ${saveState.s === 'recovery' ? 'text-warn' : 'text-danger'}` : `chrome hidden text-ink-3 sm:inline-flex ${hide}`}`}>
              {readonly ? <Icon name="lock" className="h-3.5 w-3.5" /> : pinned ? <Icon name="alert" className="h-3.5 w-3.5" /> : saveState.s === 'saved' ? <Icon name="check" className="h-3.5 w-3.5" /> : null}
              <span>{status}</span>
              {saveState.s === 'error' && saveState.conflict && (
                <Btn size="sm" variant="link" className="ml-1 text-ui-sm" onClick={() => setSaveDialog(true)}>
                  处理冲突
                </Btn>
              )}
            </span>
          )}
          <div className={`chrome flex items-center gap-1 ${hide}`}>
            {view === 'inspire' && loaded && <Btn size="sm" variant="primary" disabled={readonly} onClick={() => studio.enterCompose()}>开始写作</Btn>}
            {view === 'read' && loaded &&
              (compose ? (
                <Btn size="sm" variant="quiet" title="回到阅读 ⌘E" onClick={() => studio.leaveCompose()}>
                  <Icon name="book" />
                  <span className="hidden sm:inline">阅读</span>
                </Btn>
              ) : (
                <Btn size="sm" variant="outline" title={readonly ? '此章节为只读保护格式' : '沉浸式写作 ⌘E'} disabled={readonly} onClick={() => studio.enterCompose()}>
                  <Icon name="pen" />
                  <span className="hidden sm:inline">写作</span>
                </Btn>
              ))}
            {view === 'read' && compose && (
              <span className="hidden items-center gap-1 sm:flex">
                <IconBtn icon="focus" label={layout.focus ? '退出专注' : '专注'} shortcut="⌘⇧F" active={layout.focus} onClick={() => setLayout((l) => ({ ...l, focus: !l.focus }))} />
                <IconBtn icon="target" label={typewriter ? '关闭打字机模式' : '打字机模式'} active={typewriter} onClick={toggleTypewriter} />
                {!demo && <IconBtn icon="revision" label="历史版本" onClick={() => setHistory(true)} />}
              </span>
            )}
            {knowledge && (
              <KnowledgeChip
                view={knowledge}
                onOpen={() => {
                  setBookNav({ section: 'chapter', source: 'manuscript' })
                  setView('book')
                }}
              />
            )}
            <AccountMeter enabled={!demo && !!management} />
            <IconBtn icon={dark ? 'sun' : 'moon'} label={dark ? '浅色主题' : '深色主题'} onClick={() => setDark(!dark)} />
            {publicSite && !demo && (
              <Btn size="sm" variant="outline" className="sm:ml-1" title="选择章节，手动发布到 story2u" onClick={publish}>
                发布
              </Btn>
            )}
            {demo && <Proto>演示</Proto>}
          </div>
        </div>
      </header>
      {saveState.s === 'error' && !saveState.conflict && (
        <div role="alert" className="fade-up mx-3 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-danger-soft px-4 py-2.5 text-ui-sm text-danger">
          <Icon name="alert" className="shrink-0" />
          <span className="min-w-0 flex-1">{saveState.message}</span>
          <Btn size="sm" variant="outline" onClick={() => void workspace.retrySave()}>
            重试保存
          </Btn>
          <Btn size="sm" onClick={downloadLocalDraft}>
            <Icon name="download" />
            导出当前草稿
          </Btn>
        </div>
      )}
      {history && <RevisionHistory projectId={workspace.projectId} chapterId={workspace.current} onClose={() => setHistory(false)} />}
    </>
  )
}
