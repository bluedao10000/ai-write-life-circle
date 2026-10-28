import { thinkingCreateSchema, thinkingMessageInputSchema, type ThinkingCreate, type ThinkingMessageInput } from '@writer-agent/contracts'

export type PendingMessage = { key: string; id: string; input: ThinkingMessageInput; messageId?: string }
export type Outbox = { pending: Record<string, PendingMessage>; creating: {key: string; input: ThinkingCreate} | null }
export const emptyOutbox = (): Outbox => ({pending: Object.create(null) as Record<string, PendingMessage>, creating: null})
export function readOutbox(key: string): Outbox {
  const result = emptyOutbox()
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    // Adopt the previous one-slot format without changing its idempotency key.
    const rows = raw?.pending?.key ? [raw.pending] : Object.values(raw?.pending ?? {})
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue
      const p = item as PendingMessage
      if (typeof p.id !== 'string' || typeof p.key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.id)) continue
      const parsed = thinkingMessageInputSchema.safeParse(p.input)
      if (parsed.success) result.pending[p.id] = {key: p.key, id: p.id, input: parsed.data, ...(typeof p.messageId === 'string' ? {messageId: p.messageId} : {})}
    }
    if (typeof raw?.creating?.key === 'string') {
      const parsed = thinkingCreateSchema.safeParse(raw.creating.input)
      if (parsed.success) result.creating = {key: raw.creating.key, input: parsed.data}
    }
  } catch { /* Browser state is optional; the server still owns accepted requests. */ }
  return result
}
export function readChoices(key: string): Record<string, string> {
  const choices: Record<string, string> = Object.create(null) as Record<string, string>
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw)) if (typeof value === 'string') choices[id] = value
    }
  } catch { /* Optional selection preference. */ }
  return choices
}
export function saveBrowserState(key: string, value: unknown) {
  try {sessionStorage.setItem(key, JSON.stringify(value))} catch { /* Optional browser state. */ }
}
