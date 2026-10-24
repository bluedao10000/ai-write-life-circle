// Presentation types are deliberately separate from the Go/public API DTOs.
export type PublishedChapter = {
  no: number
  slug: string
  title: string
  publishedAt: number
  words: number
  paras?: string[]
  markdown?: string
}
export type Cover = {
  bg: string
  fg: string
  mark: 'rule' | 'circle' | 'wave' | 'grid' | 'none'
}
export type PublicBook = {
  slug: string
  title: string
  penName: string
  authorSlug: string
  hook: string
  synopsis: string
  categories: string[]
  status: '连载中' | '已完结' | '暂停中'
  updatedAt: number
  firstPublishedAt: number
  cover?: Cover
  coverUrl?: string
  volumes: { title: string; chapters: PublishedChapter[] }[]
  demo: boolean
}
export type PublicAuthor = {
  slug: string
  name: string
  bio: string
  demo: boolean
}
export const allChapters = (book: PublicBook) =>
  book.volumes.flatMap((v) => v.chapters)
export const latest = (book: PublicBook) => allChapters(book).at(-1)!
export const when = (at: number) =>
  new Date(at).toLocaleDateString('zh-CN', { timeZone: 'UTC' })
