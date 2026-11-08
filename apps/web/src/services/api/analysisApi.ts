import { novelAnalysisViewSchema, type NovelAnalysisView } from '@writer-agent/contracts'
import { postJson, requestApi } from './client'

const root = (id: string) => `/v1/studio/books/${encodeURIComponent(id)}/analysis`

function parse(value: unknown): NovelAnalysisView {
  try {
    return novelAnalysisViewSchema.parse(value)
  } catch {
    throw new Error('整书分析响应格式已更新，请刷新页面后重试。')
  }
}

export const analysisApi = {
  async view(id: string, signal?: AbortSignal) {
    return parse((await requestApi(root(id), { signal })).body)
  },
  async create(id: string, chapterIds?: string[]) {
    return parse(
      await postJson(
        root(id),
        chapterIds && chapterIds.length > 0 ? { chapterIds } : {},
        crypto.randomUUID(),
      ),
    )
  },
  async pause(id: string) {
    return parse(await postJson(`${root(id)}/pause`, {}, crypto.randomUUID()))
  },
  async resume(id: string) {
    return parse(await postJson(`${root(id)}/resume`, {}, crypto.randomUUID()))
  },
  async cancel(id: string) {
    return parse(await postJson(`${root(id)}/cancel`, {}, crypto.randomUUID()))
  },
  async decide(id: string, findingId: string, decision: 'confirm' | 'reject', note?: string) {
    return parse(
      await postJson(
        `${root(id)}/findings/${encodeURIComponent(findingId)}/decision`,
        { decision, ...(note ? { note } : {}) },
        crypto.randomUUID(),
      ),
    )
  },
}
