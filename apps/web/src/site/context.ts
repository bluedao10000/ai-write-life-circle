import { createContext, useContext } from 'react'
import type { PublicAuthor, PublicBook } from './data'
export type SiteData = {
  path: string
  books: PublicBook[]
  authors: PublicAuthor[]
  cats: string[]
  total: number
  nextCursor: string | null
  query: Record<string, string>
  status: number
  error?: string
}
export const emptySite: SiteData = {
  path: '/',
  books: [],
  authors: [],
  cats: [],
  total: 0,
  nextCursor: null,
  query: {},
  status: 200,
}
export const SiteContext = createContext<SiteData>(emptySite)
export function useCatalog() {
  const data = useContext(SiteContext)
  return { ...data, byUpdate: data.books, mine: undefined }
}
