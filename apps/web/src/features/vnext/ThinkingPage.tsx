import type { WriterAgentAdapter } from '../../services/writerAgent'
import type { useStudioController } from './useStudioController'
import ThinkingSpace from './ThinkingSpace'
import { Btn, Heading, Row, ago } from '../../components/vnext/ui'

export default function ThinkingPage({
  studio,
  adapter,
}: {
  studio: ReturnType<typeof useStudioController>
  adapter: WriterAgentAdapter
}) {
  const { prototype, composer, setComposer, setThinkingSeed, setView, setRightTab, setLayout } =
    studio
  if(adapter.mode !== 'demo') return <div className="scroll min-h-0 flex-1 overflow-auto"><ThinkingSpace studio={studio} demo={false} wide /></div>
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label="思考记录"
        className="scroll shrink-0 overflow-auto px-4 py-3 md:w-64 md:px-5 md:py-10"
      >
        <Btn
          variant="outline"
          className="mb-4 w-full"
          disabled={adapter.mode !== 'demo'}
          onClick={() => {
            if (
              composer.draft &&
              !window.confirm('当前还有尚未提交的思考输入。放弃后开始新的思考？')
            )
              return
            prototype.setSession(null)
            setThinkingSeed('')
            setComposer({ draft: '', mode: 'idle' })
          }}
        >
          新的思考
        </Btn>
        {adapter.mode === 'demo' && (
          <div className="hidden md:block">
            <Heading level={3} className="mb-2 px-2">
              最近 · 演示会话
            </Heading>
            {prototype.sessions
              .slice()
              .sort((a, b) => b.at - a.at)
              .map((session) => (
                <Row
                  key={session.id}
                  active={session.id === prototype.session?.id}
                  onClick={() => {
                    if (composer.draft && !window.confirm('放弃尚未提交的输入，查看这次思考？'))
                      return
                    prototype.setActiveSessionId(session.id)
                    setComposer({ draft: '', mode: 'idle' })
                  }}
                  className="px-2 py-2"
                >
                  <span className="block truncate font-prose text-ui text-ink">
                    {session.topic}
                  </span>
                  <span className="block text-micro text-ink-3">
                    {ago(session.at)}
                    {session.blocks.some((block) => block.kind === 'conclusion')
                      ? ' · 已有结论'
                      : ''}
                  </span>
                </Row>
              ))}
          </div>
        )}
        <div className="hidden px-2 pt-6 md:block">
          <Btn
            variant="link"
            className="text-ui-sm"
            onClick={() => {
              setView('write')
              setRightTab('think')
              setLayout((layout) => ({ ...layout, rightOpen: true, focus: false }))
            }}
          >
            ← 收回侧栏，回到正文
          </Btn>
        </div>
      </nav>
      <main className="scroll min-h-0 flex-1 overflow-auto px-6">
        <ThinkingSpace studio={studio} demo={adapter.mode === 'demo'} wide />
      </main>
    </div>
  )
}
