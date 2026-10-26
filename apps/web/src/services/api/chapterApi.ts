import { hashMarkdown } from '../../lib/sourceHash'
import { emitGrowth } from '../../observability/growth'
import {
  chapterDetailV04Schema,
  chapterRevisionContentV04Schema,
  chapterListV04Schema,
  chapterRevisionCreateV04Schema,
  chapterRevisionSummaryV04Schema,
  type ChapterRevisionCreateV04,
} from '@writer-agent/contracts'
import { getJson, postJson } from './client'

const chaptersPath = (projectId: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}/chapters`

export async function listChapters(projectId: string) {
  return chapterListV04Schema.parse(await getJson(chaptersPath(projectId)))
}

export async function getChapter(projectId: string, chapterId: string) {
  return chapterDetailV04Schema.parse(
    await getJson(
      `${chaptersPath(projectId)}/${encodeURIComponent(chapterId)}`,
    ),
  )
}

export async function saveChapterRevision(
  projectId: string,
  chapterId: string,
  revision: ChapterRevisionCreateV04,
  idempotencyKey: string,
) {
  const request = chapterRevisionCreateV04Schema.parse(revision)
  const saved = chapterRevisionSummaryV04Schema.parse(
    await postJson(
      `${chaptersPath(projectId)}/${encodeURIComponent(chapterId)}/revisions`,
      request,
      idempotencyKey,
    ),
  )
  emitGrowth('chapter_saved')
  return saved
}
export async function listChapterRevisions(projectId: string, chapterId: string, cursor?: string, signal?: AbortSignal) {
  const body = (await getJson(`${chaptersPath(projectId)}/${encodeURIComponent(chapterId)}/revisions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal)) as { items?: unknown; total?: unknown; nextCursor?: string | null }
  if (!Array.isArray(body?.items)) throw new Error('历史版本响应格式无效。')
  return { items: body.items.map((item) => chapterRevisionSummaryV04Schema.parse(item)), total: Number(body.total) || body.items.length, nextCursor: body.nextCursor }
}

export async function getChapterRevision(projectId: string, chapterId: string, revisionId: string, signal?: AbortSignal) {
  const value = chapterRevisionContentV04Schema.parse(await getJson(`${chaptersPath(projectId)}/${encodeURIComponent(chapterId)}/revisions/${encodeURIComponent(revisionId)}`, signal))
  if (value.chapterId !== chapterId || value.revision.revisionId !== revisionId || await hashMarkdown(value.revision.markdown) !== value.revision.contentHash) throw new Error('历史正文校验失败，请重新读取。')
  return value.revision
}
