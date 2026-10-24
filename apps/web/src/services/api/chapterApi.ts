import { emitGrowth } from '../../observability/growth'
import {
  chapterDetailV04Schema,
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
/** Saved revision metadata. Content stays on the server. */
export async function listChapterRevisions(projectId: string, chapterId: string) {
  const body = (await getJson(`${chaptersPath(projectId)}/${encodeURIComponent(chapterId)}/revisions?limit=200`)) as { items?: unknown; total?: unknown }
  if (!Array.isArray(body?.items)) throw new Error('历史版本响应格式无效。')
  return { items: body.items.map((item) => chapterRevisionSummaryV04Schema.parse(item)), total: Number(body.total) || body.items.length }
}
