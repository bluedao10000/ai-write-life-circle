import ThinkingSession from '../../components/vnext/ThinkingSession'
import ThinkingPanel from '../thinking/ThinkingPanel'
import type { useStudioController } from './useStudioController'
export default function ThinkingSpace({
  studio,
  demo,
  wide,
}: {
  studio: ReturnType<typeof useStudioController>
  demo: boolean
  wide: boolean
}) {
  const {
    prototype,
    thinkingSeed,
    selection,
    composer,
    setComposer,
    current,
    saveNote,
    openNotes,
  } = studio
  const agent = prototype.thinkingAgent
  if (!demo) return <ThinkingPanel studio={studio} />
  if (!agent)
    return (
      <p role="status" className="px-5 text-ui text-ink-3">
        正在读取思考演示…
      </p>
    )
  return (
    <ThinkingSession
      agent={agent}
      composer={composer}
      setComposer={setComposer}
      session={prototype.session}
      seedQuote={thinkingSeed || selection}
      wide={wide}
      onStart={(idea, quote) =>
        prototype.setSession({
          id: crypto.randomUUID(),
          topic: idea,
          at: Date.now(),
          chapterId: current,
          blocks: [{ kind: 'idea', text: idea, quote }, agent.understand(idea, quote)],
        })
      }
      onBlocks={(blocks) =>
        prototype.setSession((session) => (session ? { ...session, blocks } : session))
      }
      onConclude={saveNote}
      onOpenNote={openNotes}
    />
  )
}
