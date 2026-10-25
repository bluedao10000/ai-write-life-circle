import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearLocalChapterDrafts, clearScopeDrafts, countScopeDrafts, readLocalChapterDraft, writeLocalChapterDraft, type LocalChapterDraft } from '../services/localChapterDraft'
import { clearScopedSession, readScopedSession, scopedKey, setStorageScope, writeScopedSession } from '../services/storageScope'

const draft = (markdown: string, chapterId = 'CH-1'): LocalChapterDraft => ({ projectId: 'book-1', chapterId, baseRevisionId: null, markdown, idempotencyKey: 'k', updatedAt: '2026-10-25T00:00:00Z' })
const ALICE = 'aliceScope000000000000'
const BOB = 'bobScope00000000000000'

describe('per-account browser storage (SEC-002)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  afterEach(() => setStorageScope(undefined))

  it('keeps historical keys when nobody is signed in', () => {
    setStorageScope(undefined)
    writeLocalChapterDraft(draft('本地'))
    expect(localStorage.getItem('writer-agent.api-draft.v1:book-1:CH-1')).toContain('本地')
    expect(scopedKey('writer-agent:selected-book')).toBe('writer-agent:selected-book')
  })

  it('never shows one account the recovery draft of another', () => {
    setStorageScope(ALICE)
    writeLocalChapterDraft(draft('Alice 的未保存正文'))
    expect(readLocalChapterDraft('book-1', 'CH-1')?.markdown).toBe('Alice 的未保存正文')
    setStorageScope(BOB)
    expect(readLocalChapterDraft('book-1', 'CH-1')).toBeNull()
    expect(countScopeDrafts()).toBe(0)
    writeLocalChapterDraft(draft('Bob'))
    setStorageScope(ALICE)
    expect(readLocalChapterDraft('book-1', 'CH-1')?.markdown).toBe('Alice 的未保存正文')
  })

  it('moves a pre-account draft into the first account that opens its book', () => {
    localStorage.setItem('writer-agent.api-draft.v1:book-1:CH-1', JSON.stringify(draft('旧草稿')))
    setStorageScope(ALICE)
    expect(readLocalChapterDraft('book-1', 'CH-1')?.markdown).toBe('旧草稿')
    expect(localStorage.getItem('writer-agent.api-draft.v1:book-1:CH-1')).toBeNull()
    setStorageScope(BOB)
    expect(readLocalChapterDraft('book-1', 'CH-1')).toBeNull()
  })

  it('sign-out removes only the signed-out account drafts and session state', () => {
    setStorageScope(BOB)
    writeLocalChapterDraft(draft('Bob'))
    writeScopedSession('writer-agent:selected-book', 'book-bob')
    setStorageScope(ALICE)
    writeLocalChapterDraft(draft('Alice', 'CH-1'))
    writeLocalChapterDraft(draft('Alice 2', 'CH-2'))
    writeScopedSession('writer-agent:selected-book', 'book-alice')
    expect(countScopeDrafts()).toBe(2)
    clearScopeDrafts()
    clearScopedSession()
    expect(countScopeDrafts()).toBe(0)
    expect(readScopedSession('writer-agent:selected-book')).toBeNull()
    setStorageScope(BOB)
    expect(readLocalChapterDraft('book-1', 'CH-1')?.markdown).toBe('Bob')
  })

  it('clears a deleted book in the current account and legacy keys', () => {
    setStorageScope(ALICE)
    writeLocalChapterDraft(draft('Alice'))
    localStorage.setItem('writer-agent.api-draft.v1:book-1:CH-9', JSON.stringify(draft('旧', 'CH-9')))
    clearLocalChapterDrafts('book-1')
    expect(localStorage.length).toBe(0)
  })

  it('adopts an unscoped selected work once, then keeps it per account', () => {
    sessionStorage.setItem('writer-agent:selected-book', 'book-legacy')
    setStorageScope(ALICE)
    expect(readScopedSession('writer-agent:selected-book')).toBe('book-legacy')
    expect(sessionStorage.getItem('writer-agent:selected-book')).toBeNull()
    setStorageScope(BOB)
    expect(readScopedSession('writer-agent:selected-book')).toBeNull()
  })
})
