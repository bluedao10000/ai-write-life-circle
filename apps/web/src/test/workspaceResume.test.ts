import { afterEach, beforeEach, expect, it } from 'vitest'
import { workspaceResumeSchema, workspaceSnapshotSchema } from '@writer-agent/contracts'
import { setStorageScope } from '../services/storageScope'
import { lastBook, readResume, rememberResume, studioEntry } from '../services/workspaceResume'
const workspace = (book = 'one', text = true) => workspaceSnapshotSchema.parse({ projectId: book, projectTitle: book,
  chapters: [{ id: 'CH-001', title: '一', volume: '', meta: '', wordCount: text ? 100 : 0 }, { id: 'CH-002', title: '二', volume: '', meta: '' }],
  knowledge: [], document: {}, chapterVersions: {}, proposals: [], decisions: [], chat: [], challenge: [], sequence: 0, currentChapterId: 'CH-001' })
const position = workspaceResumeSchema.parse({ schema: 1, chapterId: 'CH-002', view: 'read', compose: true, scroll: 800, from: 20, to: 25, revisionId: 'draft:one', updatedAt: '2026-10-26T01:00:00Z' })
beforeEach(() => { localStorage.clear(); setStorageScope('account_one') })
afterEach(() => setStorageScope(undefined))
it('returns existing prose to writing and empty works to inspiration', () => {
  expect(studioEntry(workspace(), '').view).toBe('read')
  expect(studioEntry(workspace(), '').compose).toBe(true)
  expect(studioEntry(workspace('empty', false), '').view).toBe('inspire')
})
it('restores account/book metadata and honors an explicit reading link', () => {
  rememberResume('one', position)
  expect(studioEntry(workspace(), '').chapterId).toBe('CH-002')
  expect(studioEntry(workspace(), '').position).toEqual(position)
  const explicit = studioEntry(workspace(), '?chapter=CH-001&view=read')
  expect(explicit.chapterId).toBe('CH-001'); expect(explicit.compose).toBe(false)
  expect(studioEntry(workspace('two'), '').position).toBeUndefined()
  setStorageScope('account_two')
  expect(lastBook()).toBeNull(); expect(readResume('one')).toBeUndefined()
  setStorageScope('account_one'); expect(lastBook()).toBe('one')
})
it('rejects foreign/deleted chapters, corrupt records and invalid position bounds', () => {
  rememberResume('one', { ...position, chapterId: 'deleted' })
  expect(studioEntry(workspace(), '').chapterId).toBe('CH-001')
  expect(workspaceResumeSchema.safeParse({ ...position, scroll: -1 }).success).toBe(false)
  expect(workspaceResumeSchema.safeParse({ ...position, markdown: 'private prose' }).success).toBe(false)
})

it('uses newer server metadata when another device moved the workbench', () => {
  rememberResume('one', position)
  const snapshot=workspace()
  const server={...position,chapterId:'CH-001',scroll:300,updatedAt:'2026-10-26T02:00:00Z'}
  snapshot.preferences={theme:'light',resume:server}
  expect(studioEntry(snapshot,'').position).toEqual(server)
})
