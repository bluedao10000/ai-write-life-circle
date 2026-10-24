import { managementApi } from './api/managementApi'
import { httpReviewsAdapter } from './api/reviewsApi'
import { httpNotesAdapter } from './api/notesApi'
import type {
  ChallengeResponse,
  ChatResponse,
  RunReviewResponse,
  SaveChapterResponse,
  UserWorkspaceStateV04,
} from '@writer-agent/contracts'
import type { ApiWriterAgentAdapter } from './writerAgent'
import { getChapter, listChapters, saveChapterRevision } from './api/chapterApi'
import { patchWorkspace, getWorkspace } from './api/workspaceApi'
import { mapWorkspaceToStudio } from './mappers/workspaceMapper'

function unavailable(feature: string): never {
  throw new Error(`${feature} 尚未接入 V0.4 API；当前 API 模式不会回退到演示响应。`)
}

/** V0.4 HTTP adapter. Only implemented Workspace and Chapter endpoints are called. */
export function createHttpWriterAgentAdapter(): ApiWriterAgentAdapter {
  return {
    mode: 'api',
    management: managementApi,
    notes: httpNotesAdapter,
    reviews: httpReviewsAdapter,
    async loadWorkspace(projectId) {
      const [workspace, chapters] = await Promise.all([getWorkspace(projectId), listChapters(projectId)])
      if (workspace.project.projectId !== projectId) {
        throw new Error('Workspace 响应的 projectId 与当前配置不一致。')
      }
      return mapWorkspaceToStudio(workspace, chapters)
    },
    async loadChapter(projectId, chapterId) {
      const detail = await getChapter(projectId, chapterId)
      if (detail.chapterId !== chapterId) throw new Error('Chapter 响应的 chapterId 与请求不一致。')
      return detail
    },
    async saveChapterRevision(input) {
      return saveChapterRevision(input.projectId, input.chapterId, input.revision, input.idempotencyKey)
    },
    async updateWorkspaceState(projectId: string, state: UserWorkspaceStateV04) {
      return patchWorkspace(projectId, state)
    },
    async saveChapter(): Promise<SaveChapterResponse> {
      return unavailable('旧版章节保存接口')
    },
    async runReview(): Promise<RunReviewResponse> {
      return unavailable('Agent 审查')
    },
    async sendMessage(): Promise<ChatResponse> {
      return unavailable('Agent 对话')
    },
    async challenge(): Promise<ChallengeResponse> {
      return unavailable('创作推演')
    },
  }
}
