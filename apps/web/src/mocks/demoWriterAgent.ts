import { demoNotesAdapter } from './demoNotes'
import {
  chapterVersionSchema,
  challengeRoundSchema,
  chatMessageSchema,
  decisionSchema,
  documentSchema,
  markdownDocumentSchema,
  proposalSchema,
  workspaceSnapshotSchema,
  type ChallengeRequest,
  type ChallengeRound,
  type ChallengeResponse,
  type ChatRequest,
  type ChatMessage,
  type ChatResponse,
  type ChapterVersion,
  type Decision,
  type Proposal,
  type RunReviewRequest,
  type RunReviewResponse,
  type SaveChapterRequest,
  type SaveChapterResponse,
} from '@writer-agent/contracts'
import { mockChallenge, mockChat, mockReview } from './demoData'
import type { WriterAgentAdapter, WriterAgentSeed } from '../services/writerAgent'
import { ChapterRevisionConflictError } from '../services/writerAgent'
import { hashMarkdown, hashText } from '../lib/sourceHash'
import { plainParagraphsToMarkdown } from '../lib/manuscriptMarkdown'

const STORAGE_KEY = 'writer-agent.v2'

function readLegacyDemoVersion(value: unknown): { revision: number; sourceHash: string } | null {
  if (typeof value !== 'object' || value === null || !('revision' in value) || !('sourceHash' in value)) return null
  return typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 0 && typeof value.sourceHash === 'string'
    ? { revision: value.revision, sourceHash: value.sourceHash }
    : null
}

type StoredWorkspace = {
  doc?: Record<string, string[]>
  markdownByChapter?: Record<string, string>
  proposals?: Proposal[]
  decisions?: Decision[]
  chat?: ChatMessage[]
  challenge?: ChallengeRound[]
  seq?: number
  current?: string
  chapterVersions?: Record<string, ChapterVersion>
}

function readStoredWorkspace(): StoredWorkspace {
  if (typeof localStorage === 'undefined') return {}
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!value || typeof value !== 'object') return {}
    const saved = value as Record<string, unknown>
    const doc = documentSchema.safeParse(saved.doc)
    const markdownByChapter = markdownDocumentSchema.safeParse(saved.markdownByChapter)
    const proposals = proposalSchema.array().safeParse(saved.proposals)
    const decisions = decisionSchema.array().safeParse(saved.decisions)
    const chat = chatMessageSchema.array().safeParse(saved.chat)
    const challenge = challengeRoundSchema.array().safeParse(saved.challenge)
    const chapterVersions = saved.chapterVersions && typeof saved.chapterVersions === 'object'
      ? Object.fromEntries(Object.entries(saved.chapterVersions).flatMap(([id, version]) => {
        const parsed = chapterVersionSchema.safeParse(version)
        if (parsed.success && parsed.data.mode === 'demo') return [[id, parsed.data]]
        const legacy = readLegacyDemoVersion(version)
        return legacy ? [[id, { mode: 'demo' as const, ...legacy }]] : []
      }))
      : undefined
    return {
      doc: doc.success ? doc.data : undefined,
      markdownByChapter: markdownByChapter.success ? markdownByChapter.data : undefined,
      proposals: proposals.success ? proposals.data : undefined,
      decisions: decisions.success ? decisions.data : undefined,
      chat: chat.success ? chat.data : undefined,
      challenge: challenge.success ? challenge.data : undefined,
      seq: typeof saved.seq === 'number' && Number.isInteger(saved.seq) && saved.seq >= 0 ? saved.seq : undefined,
      current: typeof saved.current === 'string' ? saved.current : undefined,
      chapterVersions,
    }
  } catch {
    return {}
  }
}

/** Demo-only adapter. All Agent-like replies are deterministic templates and marked as demo. */
export function createDemoWriterAgentAdapter(seed: WriterAgentSeed): WriterAgentAdapter {
  const versionsByProject = new Map<string, Map<string, ChapterVersion>>()
  const snapshotsByProject = new Map<string, Awaited<ReturnType<WriterAgentAdapter['loadWorkspace']>>>()

  return {
    mode: 'demo',
    notes: demoNotesAdapter,
    async loadWorkspace(projectId) {
      const stored = readStoredWorkspace()

      const document = { ...seed.document, ...stored.doc }
      const markdownByChapter = {
        ...Object.fromEntries(Object.entries(document).map(([chapterId, paragraphs]) => [chapterId, plainParagraphsToMarkdown(paragraphs)])),
        ...seed.markdownByChapter,
        ...stored.markdownByChapter,
      }
      const chapterVersions: Record<string, ChapterVersion> = {}
      for (const chapter of seed.chapters) {
        const markdown = markdownByChapter[chapter.id] ?? plainParagraphsToMarkdown(document[chapter.id] ?? [])
        const savedVersion = stored.chapterVersions?.[chapter.id]
      chapterVersions[chapter.id] = {
          mode: 'demo',
          revision: savedVersion?.mode === 'demo' ? savedVersion.revision : 0,
          sourceHash: await hashMarkdown(markdown),
        }
      }
      const chapterIds = new Set(seed.chapters.map((chapter) => chapter.id))
      const defaultChapterId = chapterIds.has('c12') ? 'c12' : seed.chapters[0]?.id
      const snapshot = workspaceSnapshotSchema.parse({
        capabilities: { notes: true, agentRuntime: false, knowledge: false, annotations: false, canonChanges: false },
        projectId,
        projectTitle: '江宁旧事',
        chapters: seed.chapters,
        knowledge: seed.knowledge,
        document,
        markdownByChapter,
        chapterVersions,
        proposals: stored.proposals ?? [],
        decisions: stored.decisions ?? [],
        chat: stored.chat ?? [],
        challenge: stored.challenge ?? [],
        sequence: stored.seq ?? 0,
        currentChapterId: stored.current && chapterIds.has(stored.current) ? stored.current : defaultChapterId,
      })
      versionsByProject.set(projectId, new Map(Object.entries(chapterVersions)))
      snapshotsByProject.set(projectId, snapshot)
      return snapshot
    },
    async saveChapter(input: SaveChapterRequest): Promise<SaveChapterResponse> {
      const versions = versionsByProject.get(input.projectId)
      const current = versions?.get(input.chapterId)
      if (!current || current.mode !== 'demo') throw new Error('演示工作区尚未加载，无法保存章节。')
      if (current.mode !== 'demo' || current.revision !== input.revision) throw new ChapterRevisionConflictError()

      const actualHash = await hashMarkdown(input.markdown)
      if (actualHash !== input.sourceHash) throw new Error('保存内容版本与提交的校验值不一致。')
      const version = { mode: 'demo' as const, revision: current.revision + 1, sourceHash: actualHash }
      versions?.set(input.chapterId, version)
      const snapshot = snapshotsByProject.get(input.projectId)
      if (snapshot) {
        snapshot.chapterVersions[input.chapterId] = version
        snapshot.document[input.chapterId] = [...input.paragraphs]
        snapshot.markdownByChapter ??= {}
        snapshot.markdownByChapter[input.chapterId] = input.markdown
      }
      return { projectId: input.projectId, chapterId: input.chapterId, ...version, savedAt: Date.now() }
    },
    async runReview(input: RunReviewRequest): Promise<RunReviewResponse> {
      const snapshot = snapshotsByProject.get(input.projectId)
      if (!snapshot) throw new Error('演示工作区尚未加载，无法审查。')
      const actualHash = await hashMarkdown(input.markdown)
      if (actualHash !== input.sourceHash) throw new Error('审查内容版本与提交的校验值不一致。')

      const proposals = await Promise.all(mockReview(input.chapterId, { [input.chapterId]: input.paragraphs }, input.sequence).map(async (proposal) => {
        const evidenceRefs = await Promise.all(proposal.evidence.map(async (evidence) => {
          if (evidence.type === 'chapter') {
            const version = snapshot.chapterVersions[evidence.chapterId]
            return {
              type: 'chapter' as const,
              sourceId: `${evidence.chapterId}#${evidence.paraIndex}`,
              chapterId: evidence.chapterId,
              paraIndex: evidence.paraIndex,
              sourceHash: version?.mode === 'demo' ? version.sourceHash : undefined,
              revision: version?.mode === 'demo' ? version.revision : undefined,
            }
          }
          if (evidence.type === 'knowledge') {
            const entry = snapshot.knowledge.find((item) => item.id === evidence.entryId)
            return { type: 'knowledge' as const, sourceId: evidence.entryId, sourceHash: entry ? await hashText(entry.body) : undefined }
          }
          return { type: 'external' as const, sourceId: evidence.label }
        }))
        return {
          ...proposal,
          projectId: input.projectId,
          reviewRunId: input.reviewRunId,
          chapterRevision: input.revision,
          sourceHash: input.sourceHash,
          evidenceRefs,
        }
      }))
      const unresolved = proposals.flatMap((proposal) => proposal.evidenceRefs ?? []).filter((ref) => !ref.sourceHash)
      return {
        projectId: input.projectId,
        chapterId: input.chapterId,
        revision: input.revision,
        sourceHash: input.sourceHash,
        reviewRunId: input.reviewRunId,
        proposals,
        demo: true,
        coverage: { requestedScopes: input.scope, completedScopes: input.scope, complete: true },
        evidenceValidation: { status: unresolved.length ? 'partial' : 'valid', unresolved },
      }
    },
    async sendMessage(input: ChatRequest): Promise<ChatResponse> {
      return { ...mockChat(input.text, input.quote), demo: true }
    },
    async challenge(input: ChallengeRequest): Promise<ChallengeResponse> {
      return { ...mockChallenge(input.intent, input.previousRounds), demo: true }
    },
  }
}
