import {cleanup,render,screen,waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterEach,expect,it,vi} from 'vitest'
import MemoryExtraction from '../features/memory/MemoryExtraction'
import {thinkingApi as api} from '../services/api/thinkingApi'
import type {ThinkingSession} from '@writer-agent/contracts'
vi.mock('../services/api/thinkingApi',()=>({thinkingApi:{models:vi.fn(),list:vi.fn(),create:vi.fn(),send:vi.fn(),get:vi.fn(),cancel:vi.fn(),memoryCandidate:vi.fn()}}))
const model={modelId:'fixture',displayName:'测试模型',provider:'fixture',hostedBy:'本地测试',description:'',enabled:true,toolCalling:true,pointMultiplier:1 as const}
const session={sessionId:'th-fixture',title:'提取经验',status:'idle',memoryExtraction:{version:1,tasks:[{taskId:'t1',resultVersion:1}]},messages:[{role:'assistant',text:JSON.stringify({content:'先核对原文，再判断差异。',taskIds:['t1']})}],run:{runId:'run',status:'completed'}} as ThinkingSession
function setup(){vi.mocked(api.models).mockResolvedValue([model]);vi.mocked(api.list).mockResolvedValue([]);vi.mocked(api.create).mockResolvedValue(session);vi.mocked(api.get).mockResolvedValue(session)}
afterEach(()=>{cleanup();vi.resetAllMocks()})
it('discloses the model and selected data before a paid call, then saves only on author action',async()=>{
 setup();const saved=vi.fn().mockResolvedValue(undefined)
 render(<MemoryExtraction bookId="book" taskIds={['t1']} onSaved={saved}/>);
 expect(api.models).not.toHaveBeenCalled();expect(api.create).not.toHaveBeenCalled()
 await userEvent.click(screen.getByRole('button',{name:'AI 提取经验'}))
 await screen.findByText(/将上方选中的 1 个任务/)
 await waitFor(()=>expect(screen.getByRole('button',{name:'同意发送并提取'})).toBeEnabled())
 expect(api.create).not.toHaveBeenCalled()
 await userEvent.click(screen.getByRole('button',{name:'同意发送并提取'}))
 await screen.findByText('先核对原文，再判断差异。')
 expect(api.create).toHaveBeenCalledWith('book',{consent:true,modelId:'fixture',memoryExtraction:{taskIds:['t1']}},expect.any(String))
 expect(api.memoryCandidate).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled()
 await userEvent.click(screen.getByRole('button',{name:'保存提取候选'}))
 await screen.findByText('已保存为待审核候选，请在下方确认或撤回。')
 expect(api.memoryCandidate).toHaveBeenCalledWith('book','th-fixture','run');expect(saved).toHaveBeenCalledOnce()
})
it('does not admit more than four selected sources',async()=>{
 setup();render(<MemoryExtraction bookId="book" taskIds={['1','2','3','4','5']} onSaved={async()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'AI 提取经验'}));await screen.findByRole('option',{name:'测试模型 · 本地测试'})
 expect(screen.getByRole('button',{name:'同意发送并提取'})).toBeDisabled();expect(api.create).not.toHaveBeenCalled()
})
it('reuses the same admission identity after an uncertain send failure',async()=>{
 setup();vi.mocked(api.send).mockRejectedValueOnce(Error('连接中断'))
 render(<MemoryExtraction bookId="book" taskIds={['t1']} onSaved={async()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'AI 提取经验'}));await screen.findByRole('option',{name:'测试模型 · 本地测试'})
 await userEvent.click(screen.getByRole('button',{name:'同意发送并提取'}));await screen.findByRole('alert')
 expect(api.send).toHaveBeenCalledTimes(1)
 await userEvent.click(screen.getByRole('button',{name:'继续本次请求'}));await screen.findByText('先核对原文，再判断差异。')
 expect(api.create).toHaveBeenCalledOnce();expect(vi.mocked(api.send).mock.calls[1]).toEqual(vi.mocked(api.send).mock.calls[0])
})
it('opens an existing interrupted extraction without starting another model call',async()=>{
 setup();vi.mocked(api.list).mockResolvedValue([session]);vi.mocked(api.get).mockResolvedValue({...session,run:{...session.run!,status:'interrupted'},messages:[]})
 render(<MemoryExtraction bookId="book" taskIds={[]} onSaved={async()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'AI 提取经验'}));await screen.findByRole('combobox',{name:'已有提取'})
 await userEvent.selectOptions(screen.getByRole('combobox',{name:'已有提取'}),'th-fixture');await screen.findByText('本次提取已停止。')
 expect(api.create).not.toHaveBeenCalled();expect(api.send).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'保存提取候选'})).not.toBeInTheDocument()
})
