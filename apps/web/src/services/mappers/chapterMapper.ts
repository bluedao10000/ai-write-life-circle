import { chapterVersionSchema, type ApiChapterVersion, type Chapter, type ChapterDetailV04 } from '@writer-agent/contracts'

export type MappedChapterDetail = {
  chapter: Chapter
  markdown: string
  version: ApiChapterVersion
}

/** Keep the API's opaque revision ID and Markdown content hash intact. */
export function mapChapterDetail(detail: ChapterDetailV04, volumeLabel?: string): MappedChapterDetail {
  if (!detail.chapterId.trim() || !detail.title.trim()) {
    throw new Error('章节详情缺少 chapterId 或标题，已停止加载。')
  }
  const { headRevision } = detail
  if (!headRevision.revisionId?.trim() || !headRevision.contentHash) {
    throw new Error(`章节 ${detail.chapterId} 缺少服务端版本标识或正文 Hash，已停止编辑。`)
  }
  const version = chapterVersionSchema.parse({
    ...headRevision,
    mode: 'api',
    revisionId: headRevision.revisionId,
    parentRevisionId: headRevision.parentRevisionId ?? null,
    contentHash: headRevision.contentHash,
  })
  if (version.mode !== 'api') throw new Error('章节版本类型与 API 模式不匹配。')

  return {
    chapter: {
      id: detail.chapterId,
      volume: volumeLabel ?? detail.volumeId ?? '未分卷',
      title: detail.title,
      meta: detail.meta ?? '',
    },
    markdown: headRevision.markdown,
    version,
  }
}
