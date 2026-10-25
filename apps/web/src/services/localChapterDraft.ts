import { storageScope } from './storageScope'

export type LocalChapterDraft = {
  projectId: string
  chapterId: string
  baseRevisionId: string | null
  markdown: string
  contentHash?: string
  idempotencyKey: string
  updatedAt: string
}

// Signed-in accounts use v2 keys partitioned by account scope (SEC-002).
// Without sign-in the historical v1 keys stay in use. v1 keys predate account
// separation; a signed-in account only ever reads one for a book it can open
// (book IDs are authorized per account by the API) and moves it into its scope.
const LEGACY_PREFIX = 'writer-agent.api-draft.v1:'
function scoped(): boolean {
  return storageScope() !== 'local'
}
function scopePrefix(): string {
  return scoped() ? `writer-agent.api-draft.v2:${encodeURIComponent(storageScope())}:` : LEGACY_PREFIX
}
function storageKey(projectId: string, chapterId: string): string {
  return `${scopePrefix()}${encodeURIComponent(projectId)}:${encodeURIComponent(chapterId)}`
}
function legacyKey(projectId: string, chapterId: string): string {
  return `${LEGACY_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(chapterId)}`
}
function projectPrefixes(projectId: string): string[] {
  return [`${scopePrefix()}${encodeURIComponent(projectId)}:`, `${LEGACY_PREFIX}${encodeURIComponent(projectId)}:`]
}

export function createIdempotencyKey(): string {
  return `chapter-save:${globalThis.crypto.randomUUID()}`
}

function parse(raw: string | null, projectId: string, chapterId: string): LocalChapterDraft | null {
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
}

export function readLocalChapterDraft(projectId: string, chapterId: string): LocalChapterDraft | null {
  try {
    const storage = globalThis.localStorage
    const current = parse(storage.getItem(storageKey(projectId, chapterId)), projectId, chapterId)
    if (current || !scoped()) return current
    const legacy = parse(storage.getItem(legacyKey(projectId, chapterId)), projectId, chapterId)
    if (legacy) {
      storage.setItem(storageKey(projectId, chapterId), JSON.stringify(legacy))
      storage.removeItem(legacyKey(projectId, chapterId))
    }
    return legacy
  } catch {
    return null
  }
}

export function writeLocalChapterDraft(draft: LocalChapterDraft): void {
  globalThis.localStorage.setItem(storageKey(draft.projectId, draft.chapterId), JSON.stringify(draft))
}

export function clearLocalChapterDraft(projectId: string, chapterId: string): void {
  globalThis.localStorage.removeItem(storageKey(projectId, chapterId))
  globalThis.localStorage.removeItem(legacyKey(projectId, chapterId))
}

function keysWith(prefixes: string[]): string[] {
  const keys: string[] = []
  for (let index = 0; index < globalThis.localStorage.length; index++) {
    const key = globalThis.localStorage.key(index)
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key)
  }
  return keys
}

/** Remove recovery copies for a book that the server has permanently deleted. */
export function clearLocalChapterDrafts(projectId: string): void {
  try {
    for (const key of keysWith(projectPrefixes(projectId))) globalThis.localStorage.removeItem(key)
  } catch {
    // The server deletion is authoritative even when browser storage is unavailable.
  }
}

/** Number of unsaved recovery copies held for the current account. */
export function countScopeDrafts(): number {
  try {
    return keysWith([scopePrefix()]).length
  } catch {
    return 0
  }
}

/** Delete the current account's recovery copies (sign-out on a shared browser). */
export function clearScopeDrafts(): void {
  try {
    for (const key of keysWith([scopePrefix()])) globalThis.localStorage.removeItem(key)
  } catch {
    // Browser storage unavailable: nothing to remove.
  }
}
