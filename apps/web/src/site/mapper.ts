import type {
  PublicBook as BookDTO,
  PublicAuthor as AuthorDTO,
  PublicChapter as ChapterDTO,
} from '@writer-agent/contracts'
import type { PublicBook, PublicAuthor } from './data'
// Absent means an old snapshot with only numeric grouping. Empty means ungrouped.
export const volumeTitle = (c: { volumeTitle?: string; volumeOrder: number }) =>
  c.volumeTitle ?? `第 ${c.volumeOrder} 卷`
export function mapBook(
  dto: BookDTO,
  chapter?: ChapterDTO,
  opening?: string,
): PublicBook {
  const volumes: PublicBook['volumes'] = []
  let previousOrder: number | undefined
  dto.chapters.forEach((c, index) => {
    const title = volumeTitle(c)
    let volume = volumes.at(-1)
    if (previousOrder !== c.volumeOrder) {
      previousOrder = c.volumeOrder
      volume = { title, chapters: [] }
      volumes.push(volume)
    }
    const markdown =
      c.slug === chapter?.slug
        ? chapter.markdown
        : index === 0
          ? opening
          : undefined
    volume!.chapters.push({
      no: index + 1,
      slug: c.slug,
      title: c.title,
      publishedAt: Date.parse(c.publishedAt),
      words: markdown?.replace(/\s/g, '').length ?? 0,
      ...(markdown !== undefined
        ? { markdown, paras: markdown.split(/\n\s*\n/) }
        : {}),
    })
  })
  return {
    slug: dto.slug,
    title: dto.title,
    penName: dto.penName,
    authorSlug: dto.authorSlug,
    hook: dto.tagline,
    synopsis: dto.description,
    categories: dto.categories ?? [dto.category],
    status:
      dto.serialStatus === 'completed'
        ? '已完结'
        : dto.serialStatus === 'paused'
          ? '暂停中'
          : '连载中',
    firstPublishedAt: Date.parse(dto.firstPublishedAt),
    updatedAt: Date.parse(dto.updatedAt),
    cover: dto.cover,
    coverUrl: dto.coverUrl,
    volumes,
    demo: false,
  }
}
export const mapAuthor = (dto: AuthorDTO): PublicAuthor => ({
  slug: dto.slug,
  name: dto.penName,
  bio: dto.bio,
  demo: false,
})
