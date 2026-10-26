import { workspaceResumeSchema, type WorkspaceResume, type WorkspaceSnapshot } from '@writer-agent/contracts'
import { scopedKey } from './storageScope'

const lastBookKey = 'writer-agent:last-book-v1'
const resumeKey = (book: string) => scopedKey('writer-agent:resume-v1:' + book)
export function lastBook(): string | null {
  try { return localStorage.getItem(scopedKey(lastBookKey)) } catch { return null }
}
export function readResume(book: string): WorkspaceResume | undefined {
  try {
    const parsed = workspaceResumeSchema.safeParse(JSON.parse(localStorage.getItem(resumeKey(book)) ?? 'null'))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}
export function rememberResume(book: string, resume: WorkspaceResume) {
  try {
    localStorage.setItem(resumeKey(book), JSON.stringify(workspaceResumeSchema.parse(resume)))
    localStorage.setItem(scopedKey(lastBookKey), book)
  } catch { /* Optional metadata; server preferences remain available. */ }
}
export function forgetResume(book: string) {
  try {
    localStorage.removeItem(resumeKey(book))
    if (lastBook() === book) localStorage.removeItem(scopedKey(lastBookKey))
  } catch { /* Optional metadata. */ }
}
export function studioEntry(workspace: WorkspaceSnapshot, search: string) {
  const params = new URLSearchParams(search)
  const local = readResume(workspace.projectId)
  const server = workspace.preferences?.resume
  const saved = [local, server].filter((item): item is WorkspaceResume => !!item && workspace.chapters.some((c) => c.id === item.chapterId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const requested = params.get('chapter')
  const chapterId = workspace.chapters.find((c) => c.id === requested)?.id ?? saved?.chapterId ?? workspace.currentChapterId
  const raw = params.get('view')
  const view = raw === 'write' ? 'read' : raw === 'think' ? 'inspire' : raw
  const explicit = params.has('view') || params.has('compose') || params.has('chapter')
  const hasText = workspace.chapters.some((c) => (c.wordCount ?? 0) > 0) || Object.values(workspace.markdownByChapter ?? {}).some((text) => text.trim())
    || Object.values(workspace.document).some((paragraphs) => paragraphs.some((p) => p.trim()))
  return {
    chapterId,
    view: (explicit ? (view === 'book' || view === 'inspire' ? view : 'read') : saved?.view ?? (hasText ? 'read' : 'inspire')) as WorkspaceResume['view'],
    compose: explicit ? params.get('compose') === '1' : saved?.compose ?? !!hasText,
    position: saved?.chapterId === chapterId ? saved : undefined,
    automatic: !explicit && !saved,
  }
}
