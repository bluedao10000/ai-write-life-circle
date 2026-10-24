import type { ReviewsAdapter } from './api/reviewsApi'
import type { NotesAdapter } from './api/notesApi'
import type {
  ChallengeRequest,
  ChallengeResponse,
  ChatRequest,
  ChatResponse,
  Document,
  MarkdownDocument,
  KnowledgeEntry,
  Chapter,
  RunReviewResponse,
  RunReviewRequest,
  SaveChapterRequest,
  SaveChapterResponse,
  WorkspaceSnapshot,
  ChapterRevisionCreateV04,
  ChapterRevisionSummaryV04,
  ChapterDetailV04,
  UserWorkspaceStateV04,
} from '@writer-agent/contracts'

export type WriterAgentSeed = {
  chapters: Chapter[]
  knowledge: KnowledgeEntry[]
  document: Document
  markdownByChapter?: MarkdownDocument
}

export class ChapterRevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT'

  constructor(
    message = '章节已在其他位置更新。请保留当前编辑并重新加载最新版本后再保存。',
    readonly currentRevisionId?: string,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ChapterRevisionConflictError'
  }
}

export class ApiProblemError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly current?: unknown,
  ) {
    super(message)
    this.name = 'ApiProblemError'
  }
}

/** Replace this adapter without changing the studio components. */
type ManagementAdapter = typeof import('./api/managementApi').managementApi
export type BookManagementAdapter = Pick<ManagementAdapter, 'list' | 'mutate'> &
  Partial<Pick<ManagementAdapter, 'deleteBook' | 'uploadEPUB' | 'getImport' | 'commitImport' | 'deleteImport'>>
type WriterAgentAdapterBase = {
  management?: BookManagementAdapter
  notes?: NotesAdapter
  reviews?: ReviewsAdapter
  loadWorkspace(projectId: string): Promise<WorkspaceSnapshot>
  saveChapter(input: SaveChapterRequest): Promise<SaveChapterResponse>
  runReview(input: RunReviewRequest): Promise<RunReviewResponse>
  sendMessage(input: ChatRequest): Promise<ChatResponse>
  challenge(input: ChallengeRequest): Promise<ChallengeResponse>
}

export type DemoWriterAgentAdapter = WriterAgentAdapterBase & { readonly mode: 'demo' }
export type ApiWriterAgentAdapter = WriterAgentAdapterBase & {
  readonly mode: 'api'
  loadChapter(projectId: string, chapterId: string): Promise<ChapterDetailV04>
  saveChapterRevision(input: {
    projectId: string
    chapterId: string
    revision: ChapterRevisionCreateV04
    idempotencyKey: string
  }): Promise<ChapterRevisionSummaryV04>
  updateWorkspaceState(projectId: string, state: UserWorkspaceStateV04): Promise<UserWorkspaceStateV04>
}
export type WriterAgentAdapter = DemoWriterAgentAdapter | ApiWriterAgentAdapter

export type { ChallengeRequest, ChatRequest, RunReviewRequest, SaveChapterRequest }
