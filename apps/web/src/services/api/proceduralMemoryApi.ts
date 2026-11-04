import { proceduralListSchema, proceduralEvidenceListSchema, proceduralRecordSchema, proceduralCreateSchema, proceduralDecisionSchema } from '@writer-agent/contracts'
import type { z } from 'zod'
import { getJson, postJson } from './client'

export type ProceduralMemory = z.infer<typeof proceduralListSchema>['items'][number]
export type TaskEvidence = z.infer<typeof proceduralEvidenceListSchema>['items'][number]
export type MemoryCreate = z.infer<typeof proceduralCreateSchema>
export type MemoryDecision = z.infer<typeof proceduralDecisionSchema>
const root = (book: string) => `/v1/studio/books/${encodeURIComponent(book)}/procedural-memory`
function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value) } catch { throw Error('操作经验响应格式已更新，请刷新后重试。') }
}
export const proceduralMemoryApi = {
  async list(book: string, signal?: AbortSignal) { return parse(proceduralListSchema, await getJson(root(book), signal)).items },
  async evidence(book: string, signal?: AbortSignal) { return parse(proceduralEvidenceListSchema, await getJson(`${root(book)}/evidence`, signal)).items },
  async create(book: string, input: MemoryCreate, key: string) { return parse(proceduralRecordSchema, await postJson(root(book), proceduralCreateSchema.parse(input), key)) },
  async decide(book: string, id: string, input: MemoryDecision, key: string) { return parse(proceduralRecordSchema, await postJson(`${root(book)}/${encodeURIComponent(id)}`, proceduralDecisionSchema.parse(input), key)) },
}
