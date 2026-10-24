export type LocalChapterDraft = {
  projectId: string
  chapterId: string
  baseRevisionId: string | null
  markdown: string
  contentHash?: string
  idempotencyKey: string
  updatedAt: string
}

function storageKey(projectId: string, chapterId: string): string {
  return `writer-agent.api-draft.v1:${encodeURIComponent(projectId)}:${encodeURIComponent(chapterId)}`
}
function projectPrefix(projectId: string): string {
  return `writer-agent.api-draft.v1:${encodeURIComponent(projectId)}:`
}

export function createIdempotencyKey(): string {
  return `chapter-save:${globalThis.crypto.randomUUID()}`
}

export function readLocalChapterDraft(projectId: string, chapterId: string): LocalChapterDraft | null {
  try {
    const raw = globalThis.localStorage.getItem(storageKey(projectId, chapterId))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    if (
      !('projectId' in value) || value.projectId !== projectId
      || !('chapterId' in value) || value.chapterId !== chapterId
      || !('baseRevisionId' in value) || !(value.baseRevisionId === null || typeof value.baseRevisionId === 'string')
      || !('markdown' in value) || typeof value.markdown !== 'string'
      || !('idempotencyKey' in value) || typeof value.idempotencyKey !== 'string'
      || !('updatedAt' in value) || typeof value.updatedAt !== 'string'
      || ('contentHash' in value && typeof value.contentHash !== 'string')
    ) return null
    const contentHash = 'contentHash' in value && typeof value.contentHash === 'string' ? value.contentHash : undefined
    return {
      projectId,
      chapterId,
      baseRevisionId: value.baseRevisionId,
      markdown: value.markdown,
      ...(contentHash ? { contentHash } : {}),
      idempotencyKey: value.idempotencyKey,
      updatedAt: value.updatedAt,
    }
  } catch {
    return null
  }
}

export function writeLocalChapterDraft(draft: LocalChapterDraft): void {
  globalThis.localStorage.setItem(storageKey(draft.projectId, draft.chapterId), JSON.stringify(draft))
}

export function clearLocalChapterDraft(projectId: string, chapterId: string): void {
  globalThis.localStorage.removeItem(storageKey(projectId, chapterId))
}

/** Remove recovery copies for a book that the server has permanently deleted. */
export function clearLocalChapterDrafts(projectId: string): void {
  try {
    const prefix = projectPrefix(projectId)
    const keys: string[] = []
    for (let index = 0; index < globalThis.localStorage.length; index++) {
      const key = globalThis.localStorage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) globalThis.localStorage.removeItem(key)
  } catch {
    // The server deletion is authoritative even when browser storage is unavailable.
  }
}
