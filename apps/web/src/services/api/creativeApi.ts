import {
  creativeAssetDetailSchema,
  creativeAssetInputSchema,
  creativeAssetPageSchema,
  creativeAssetSchema,
  creativeAssetUpdateSchema,
  creativeDecideResultSchema,
  creativeDecisionInputSchema,
  creativeDivergenceListSchema,
  creativeDivergenceSchema,
  creativeJobSchema,
  creativeLinkSchema,
  creativeOverviewSchema,
  creativeProposalPageSchema,
  creativeSettingsSchema,
  creativeTurnListSchema,
  creativeTurnSchema,
  creativeWritingContextSchema,
  type CreativeAssetInput,
  type CreativeAssetUpdate,
  type CreativeDecisionInput,
  type CreativeKind,
} from '@writer-agent/contracts'
import { postJson, requestApi } from './client'

const root = (book: string) => `/v1/studio/books/${encodeURIComponent(book)}/creative`

function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value)
  } catch {
    // Contract drift must not surface raw validation output to authors.
    throw new Error('创作设定响应格式已更新，请刷新页面后重试。')
  }
}

const get = async (path: string, signal?: AbortSignal) => (await requestApi(path, { signal })).body

export const creativeApi = {
  async overview(book: string, signal?: AbortSignal) {
    return parse(creativeOverviewSchema, await get(root(book), signal))
  },
  async assets(book: string, query: { kind?: CreativeKind | string; status?: string; q?: string; cursor?: number; limit?: number } = {}, signal?: AbortSignal) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value))
    return parse(creativeAssetPageSchema, await get(`${root(book)}/assets?${params}`, signal))
  },
  async asset(book: string, id: string, signal?: AbortSignal) {
    return parse(creativeAssetDetailSchema, await get(`${root(book)}/assets/${encodeURIComponent(id)}`, signal))
  },
  async createAsset(book: string, input: CreativeAssetInput, key = crypto.randomUUID()) {
    return parse(creativeAssetSchema, await postJson(`${root(book)}/assets`, creativeAssetInputSchema.parse(input), key))
  },
  async updateAsset(book: string, id: string, input: CreativeAssetUpdate, key = crypto.randomUUID()) {
    const body = (await requestApi(`${root(book)}/assets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(creativeAssetUpdateSchema.parse(input)),
    })).body
    return parse(creativeAssetSchema, body)
  },
  async link(book: string, input: { fromAssetId: string; to: { type: 'asset' | 'knowledge_entity' | 'chapter'; id: string }; relation: string }, key = crypto.randomUUID()) {
    return parse(creativeLinkSchema, await postJson(`${root(book)}/links`, input, key))
  },
  async removeLink(book: string, id: string, key = crypto.randomUUID()) {
    return parse(creativeLinkSchema, await postJson(`${root(book)}/links/${encodeURIComponent(id)}/remove`, {}, key))
  },
  async proposals(book: string, query: { status?: string; sessionId?: string; assetId?: string; changeSetId?: string; cursor?: number; limit?: number } = {}, signal?: AbortSignal) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value))
    return parse(creativeProposalPageSchema, await get(`${root(book)}/proposals?${params}`, signal))
  },
  async decide(book: string, decisions: CreativeDecisionInput[], key = crypto.randomUUID()) {
    const body = { decisions: decisions.map((d) => creativeDecisionInputSchema.parse(d)) }
    return parse(creativeDecideResultSchema, await postJson(`${root(book)}/proposals/decide`, body, key))
  },
  async turns(book: string, sessionId: string, signal?: AbortSignal) {
    return parse(creativeTurnListSchema, await get(`${root(book)}/turns?sessionId=${encodeURIComponent(sessionId)}`, signal))
  },
  async excerpt(book: string, sessionId: string, messageId: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ sessionId, messageId })
    return parse(creativeTurnSchema, await get(`${root(book)}/turns/excerpt?${params}`, signal))
  },
  async organize(book: string, sessionId: string, messageId: string, key = crypto.randomUUID()) {
    return parse(creativeTurnSchema, await postJson(`${root(book)}/organize`, { sessionId, messageId }, key))
  },
  async context(book: string, chapterId: string, signal?: AbortSignal) {
    return parse(creativeWritingContextSchema, await get(`${root(book)}/context?chapterId=${encodeURIComponent(chapterId)}`, signal))
  },
  async planCheck(book: string, chapterId: string, key = crypto.randomUUID()) {
    return parse(creativeJobSchema, await postJson(`${root(book)}/plan-checks`, { chapterId }, key))
  },
  async divergences(book: string, chapterId: string, signal?: AbortSignal) {
    return parse(creativeDivergenceListSchema, await get(`${root(book)}/divergences?chapterId=${encodeURIComponent(chapterId)}`, signal))
  },
  async decideDivergence(book: string, id: string, action: 'update_plan' | 'adjust_future' | 'intentional' | 'dismiss', note = '', key = crypto.randomUUID()) {
    return parse(creativeDivergenceSchema, await postJson(`${root(book)}/divergences/${encodeURIComponent(id)}/decide`, note ? { action, note } : { action }, key))
  },
  async settings(book: string, action: 'enable' | 'pause' | 'resume' | 'auto', input: Record<string, unknown> = {}, key = crypto.randomUUID()) {
    return parse(creativeSettingsSchema, await postJson(`${root(book)}/settings/${action}`, input, key))
  },
}
export type CreativeApi = typeof creativeApi
