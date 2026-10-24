import { createHttpWriterAgentAdapter } from './httpWriterAgent'
import type { WriterAgentAdapter } from './writerAgent'

/** Demo fixtures are loaded only in Demo mode; API mode starts with a server workspace request. */
export async function createWriterAgentAdapter(): Promise<WriterAgentAdapter> {
  if (import.meta.env.VITE_WRITER_AGENT_MODE === 'api') return createHttpWriterAgentAdapter()

  const [{ chapters, initialDoc, knowledge }, { createDemoWriterAgentAdapter }] = await Promise.all([
    import('../mocks/demoData'),
    import('../mocks/demoWriterAgent'),
  ])
  return createDemoWriterAgentAdapter({ chapters, knowledge, document: initialDoc })
}
