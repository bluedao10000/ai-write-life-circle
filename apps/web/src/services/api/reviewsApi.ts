import {
  reviewPlanSchema, reviewRunSchema, reviewListSchema,
  type ReviewPlan, type ReviewRun, type ReviewPreviewInput, type ReviewCreate, type ReviewFeedbackInput,
} from '@writer-agent/contracts'
import { requestApi, postJson } from './client'

export interface ReviewsAdapter {
  preview(projectId: string, chapterId: string, input: ReviewPreviewInput): Promise<ReviewPlan>
  start(projectId: string, chapterId: string, input: ReviewCreate, key: string): Promise<ReviewRun>
  list(projectId: string, chapterId: string, signal?: AbortSignal): Promise<ReviewRun[]>
  get(projectId: string, runId: string, signal?: AbortSignal): Promise<ReviewRun>
  cancel(projectId: string, runId: string, key: string): Promise<ReviewRun>
  feedback(projectId: string, runId: string, findingId: string, input: ReviewFeedbackInput, key: string): Promise<ReviewRun>
}
const project = (id: string) => `/v1/projects/${encodeURIComponent(id)}`
const chapter = (id: string, cid: string) => `${project(id)}/chapters/${encodeURIComponent(cid)}`
const runPath = (id: string, runId: string) => `${project(id)}/reviews/${encodeURIComponent(runId)}`
function scoped<T extends ReviewPlan>(value: T, projectId: string, chapterId?: string): T {
  if (value.projectId !== projectId || (chapterId && value.chapterId !== chapterId)
    || value.sources.some((source) => source.projectId !== projectId)
    || value.sources.filter((s) => s.kind === 'target').length !== 1
    || value.sources.some((s) => s.kind === 'target' && (s.chapterId !== value.chapterId || s.revisionId !== value.revisionId || s.contentHash !== value.contentHash))) {
    throw new Error('审查响应与当前作品或修订不匹配。')
  }
  return value
}
function run(value: unknown, projectId: string, runId?: string): ReviewRun {
  const parsed = scoped(reviewRunSchema.parse(value), projectId)
  if (runId && parsed.runId !== runId) throw new Error('审查响应与请求的记录不匹配。')
  return parsed
}
export const httpReviewsAdapter: ReviewsAdapter = {
  async preview(projectId, chapterId, input) {
    const value = scoped(reviewPlanSchema.parse((await requestApi(`${chapter(projectId, chapterId)}/review-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })).body), projectId, chapterId)
    if (value.revisionId !== input.revisionId || value.contentHash !== input.contentHash) throw new Error('预览没有对应到准备审查的正文版本。')
    return value
  },
  async start(projectId, chapterId, input, key) {
    const value = scoped(run(await postJson(`${chapter(projectId, chapterId)}/reviews`, input, key), projectId), projectId, chapterId)
    if (value.revisionId !== input.revisionId || value.contentHash !== input.contentHash || value.planHash !== input.consent.planHash) throw new Error('审查没有绑定到已授权的版本和来源范围。')
    return value
  },
  async list(projectId, chapterId, signal) {
    return reviewListSchema.parse((await requestApi(`${chapter(projectId, chapterId)}/reviews`, { signal })).body).items.map((item) => scoped(item, projectId, chapterId))
  },
  async get(projectId, runId, signal) { return run((await requestApi(runPath(projectId, runId), { signal })).body, projectId, runId) },
  async cancel(projectId, runId, key) { return run(await postJson(`${runPath(projectId, runId)}/cancel`, {}, key), projectId, runId) },
  async feedback(projectId, runId, findingId, input, key) {
    return run(await postJson(`${runPath(projectId, runId)}/findings/${encodeURIComponent(findingId)}/feedback`, input, key), projectId, runId)
  },
}
