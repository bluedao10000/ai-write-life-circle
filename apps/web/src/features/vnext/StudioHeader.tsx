import BookMenu from '../management/BookMenu'
import { useManagement } from '../management/ManagedStudio'
import type { useStudioController } from '../vnext/useStudioController'
import { Btn, Icon, IconBtn, Seg, Proto } from '../../components/vnext/ui'
import KnowledgeChip from '../knowledge/KnowledgeChip'
import { useKnowledgeSummary } from '../knowledge/useKnowledgeSummary'
export default function StudioHeader({
  studio,
  demo,
}: {
  studio: ReturnType<typeof useStudioController>
  demo: boolean
}) {
  const management = useManagement()
  // Real data only: the chip needs a managed book and the API mode. Demo never shows it.
  const knowledge = useKnowledgeSummary(management?.book.bookId, !demo && !!management)
  const {
    view,
    setView,
    setBookNav,
    setSaveDialog,
    workspace,
    chapter,
    layout,
    setLayout,
    dark,
    setDark,
    saveState,
    downloadLocalDraft,
    pinned,
    readonly,
    status,
  } = studio
  return (
    <>
      <header className="relative z-40 flex min-h-12 shrink-0 flex-wrap items-center gap-1 px-2 sm:px-3">
        <div className="chrome flex min-w-0 items-center gap-1">
          {view === 'read' && !layout.focus && (
            <IconBtn
              icon="menu"
              label="目录与本章相关"
              shortcut="⌘⇧E"
              active={layout.leftOpen}
              onClick={() => setLayout((l) => ({ ...l, leftOpen: !l.leftOpen }))}
            />
          )}
          {management ? (
            <BookMenu />
          ) : (
            <span className="hidden max-w-40 truncate pl-1 font-prose text-ui text-ink-2 md:inline">
              {workspace.projectTitle}
            </span>
          )}
        </div>
        {/* Focus hides navigation only while composing; reading and other spaces keep it. */}
        {!(layout.focus && studio.compose) && (
          <div className="chrome mx-auto md:absolute md:left-1/2 md:mx-0 md:-translate-x-1/2">
            <Seg
              label="主导航"
              value={view}
              onChange={setView}
              options={[
                ['inspire', '灵感'],
                ['read', '阅读'],
                ['book', '书'],
              ]}
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          {import.meta.env.VITE_STORY2U_PUBLIC_SITE === 'true' && (
            <>
              <Btn
                size="sm"
                onClick={() => {
                  if (window.confirm('返回 story2u 前请确认草稿已保存。'))
                    window.location.assign('/')
                }}
              >
                story2u
              </Btn>
              {!demo && (
                <Btn
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      try {
                        if (management) await workspace.prepareStructure()
                        else if (workspace.current) await workspace.prepareReview(workspace.current)
                        window.location.assign(
                          '/studio/publish?book=' +
                            encodeURIComponent(
                              management?.book.bookId ??
                                (import.meta.env.VITE_WRITER_AGENT_PROJECT_ID || 'local'),
                            ),
                        )
                      } catch {
                        studio.toast('正文尚未安全保存，发布未开始。请先处理保存问题。')
                      }
                    })()
                  }}
                >
                  发布
                </Btn>
              )}
            </>
          )}

          {(pinned || (view === 'read' && chapter.id)) && (
            // Data-safety states never fade and never rely on colour alone (icon + text).
            <span
              className={`${readonly ? 'text-ink-2' : pinned ? (saveState.s === 'recovery' ? 'text-warn' : 'text-danger') : 'chrome hidden text-ink-3 sm:inline-flex'} inline-flex items-center gap-1.5 text-ui-sm`}
              aria-live="polite"
            >
              {readonly ? (
                <Icon name="lock" className="h-3.5 w-3.5" />
              ) : pinned ? (
                <Icon name="alert" className="h-3.5 w-3.5" />
              ) : saveState.s === 'saved' ? (
                <Icon name="check" className="h-3.5 w-3.5" />
              ) : null}
              <span>{status}</span>
            </span>
          )}
          {saveState.s === 'error' && saveState.conflict && (
            <Btn size="sm" variant="link" onClick={() => setSaveDialog(true)}>
              处理冲突
            </Btn>
          )}
          {knowledge && (
            <KnowledgeChip
              view={knowledge}
              onOpen={() => {
                setBookNav({ section: 'chapter' })
                setView('book')
              }}
            />
          )}
          <IconBtn
            icon="focus"
            label={layout.focus ? '退出专注' : '专注'}
            active={layout.focus}
            onClick={() => setLayout((l) => ({ ...l, focus: !l.focus }))}
          />
          <IconBtn
            icon={dark ? 'sun' : 'moon'}
            label={dark ? '浅色主题' : '深色主题'}
            onClick={() => setDark(!dark)}
          />
          {demo && <Proto>演示</Proto>}
        </div>
      </header>
      {saveState.s === 'error' && !saveState.conflict && (
        <div
          role="alert"
          className="fade-up mx-3 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-danger-soft px-4 py-2.5 text-ui-sm text-danger"
        >
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
    </>
  )
}
