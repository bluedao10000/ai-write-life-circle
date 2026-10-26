import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import RevisionHistory from '../features/workspace/RevisionHistory'
import type { useWorkspaceController } from '../features/workspace/useWorkspaceController'
vi.mock('../services/api/chapterApi', () => ({
 listChapterRevisions: vi.fn(async () => ({items:[{revisionId:'old',wordCount:2}],nextCursor:null})),
 getChapterRevision: vi.fn(async () => ({revisionId:'old',markdown:'昨日删除的段落。'})),
}))
const fixture = () => {
 const restoreHistoricalText=vi.fn(async()=>{})
 const workspace={projectId:'work',current:'chapter',markdownByChapter:{chapter:'当前内容'},saveState:{s:'saved'},restoreHistoricalText} as unknown as ReturnType<typeof useWorkspaceController>
 return {workspace,restoreHistoricalText}
}
describe('history content and restoration', () => {
 it('shows full bodies and requires explicit second confirmation for whole recovery', async () => {
  const {workspace,restoreHistoricalText}=fixture()
  render(<RevisionHistory workspace={workspace} onClose={()=>{}} />)
  expect(await screen.findByLabelText('历史版本正文')).toHaveValue('昨日删除的段落。')
  expect(screen.getByLabelText('当前正文')).toHaveValue('当前内容')
  fireEvent.click(screen.getByRole('button',{name:'恢复整个版本'}))
  expect(restoreHistoricalText).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'确认恢复为新版本'}))
  await waitFor(()=>expect(restoreHistoricalText).toHaveBeenCalledWith('昨日删除的段落。','replace'))
 })
 it('restores only the selected text by appending, preserving present prose',async()=>{
  const {workspace,restoreHistoricalText}=fixture()
  render(<RevisionHistory workspace={workspace} onClose={()=>{}} />)
  const area=await screen.findByLabelText('历史版本正文') as HTMLTextAreaElement
  area.setSelectionRange(0,2);fireEvent.select(area)
  fireEvent.click(screen.getByRole('button',{name:'将所选片段追加到章末'}))
  await waitFor(()=>expect(restoreHistoricalText).toHaveBeenCalledWith('昨日','append'))
 })
})
