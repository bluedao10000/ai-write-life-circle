import type { ThinkBlock } from '../features/vnext/model'
type Understanding = Extract<ThinkBlock, { kind: 'understand' }>
/** Only the explicitly selected Demo adapter supplies these deterministic operations. */
export interface PrototypeThinkingAgent {
  understand(idea: string, quote?: string): Understanding
  revise(previous: Understanding, correction: string): Understanding
  challenge(idea: string): Extract<ThinkBlock, { kind: 'challenge' }>
  research(): Extract<ThinkBlock, { kind: 'research' }>
}
