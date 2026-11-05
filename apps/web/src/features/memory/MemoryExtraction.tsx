import {useEffect,useRef,useState} from 'react'
import type {ThinkingModelOption,ThinkingSession} from '@writer-agent/contracts'
import {thinkingApi as api} from '../../services/api/thinkingApi'
import {Btn} from '../../components/vnext/ui'

type Props={bookId:string;taskIds:string[];onSaved:()=>Promise<void>}
export default function MemoryExtraction(props:Props){
 const [open,setOpen]=useState(false)
 return <section className="space-y-3 rounded-xl border border-line-soft p-4" aria-label="AI 提取经验">
  <h2 className="font-medium">让 AI 总结方法</h2>
  {open?<Extraction {...props}/>:<Btn onClick={()=>setOpen(true)}>AI 提取经验</Btn>}
 </section>
}
function Extraction({bookId,taskIds,onSaved}:Props){
 const [models,setModels]=useState<ThinkingModelOption[]>([])
 const [modelId,setModelId]=useState('')
 const [previous,setPrevious]=useState<{sessionId:string;title:string}[]>([])
 const [session,setSession]=useState<ThinkingSession>()
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 const alive=useRef(false),locked=useRef(false)
 const attempt=useRef<{key:string;taskIds:string[];modelId:string;sessionId?:string}|undefined>(undefined)
 useEffect(()=>{
  alive.current=true
  const controller=new AbortController()
  void Promise.all([api.models(bookId,controller.signal),api.list(bookId,controller.signal)]).then(([available,sessions])=>{
   if(controller.signal.aborted)return
   const enabled=available.filter(m=>m.enabled);setModels(enabled);setModelId(enabled[0]?.modelId??'')
   setPrevious(sessions.filter(s=>s.memoryExtraction))
  }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'加载失败。')})
  return()=>{alive.current=false;controller.abort()}
 },[bookId])
 const running=session?.status==='running'
 const id=session?.sessionId
 useEffect(()=>{
  if(!id||!running)return
  const controller=new AbortController()
  let timer:ReturnType<typeof setTimeout>
  const poll=async()=>{
   try{const current=await api.get(bookId,id,controller.signal);if(!controller.signal.aborted){setSession(current);if(current.status==='running')timer=setTimeout(()=>void poll(),1000)}}
   catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'读取失败，请刷新执行状态。')}
  }
  timer=setTimeout(()=>void poll(),500)
  return()=>{controller.abort();clearTimeout(timer)}
 },[bookId,id,running])
 async function perform(action:()=>Promise<void>){
  if(locked.current)return
  locked.current=true;setBusy(true);setError('');setNotice('')
  try{await action()}catch(e){if(alive.current)setError(e instanceof Error?e.message:'操作未完成，请重试。')}
  finally{locked.current=false;if(alive.current)setBusy(false)}
 }
 async function start(){
  const request=attempt.current??{key:crypto.randomUUID(),taskIds:[...taskIds],modelId}
  attempt.current=request
  if(!request.sessionId){const created=await api.create(bookId,{consent:true,modelId:request.modelId,memoryExtraction:{taskIds:request.taskIds}},request.key);request.sessionId=created.sessionId}
  await api.send(bookId,request.sessionId,{text:'请从选中任务提取可复用的操作经验，说明适用情境、方法和证据限制。'},request.key)
  const current=await api.get(bookId,request.sessionId)
  if(alive.current)setSession(current)
 }
 const selected=models.find(m=>m.modelId===modelId)
 const disclosedTasks=attempt.current?.taskIds??taskIds
 const comparisonBinding=session?.memoryExtraction&&session.memoryExtraction.version!==1?session.memoryExtraction:null
 const disclosedComparisons=comparisonBinding?.comparisons.length??0
 const result=session?.messages.at(-1)
 const complete=session?.run?.status==='completed'
 const candidate=(()=>{try{const value=JSON.parse(result?.text??'');return typeof value.content==='string'?value.content:undefined}catch{return undefined}})()
 return <div className="space-y-3 text-ui">
  {!session&&<>
   <label className="block">提取模型<select aria-label="提取模型" className="ml-2 rounded border border-line-soft bg-paper p-2" disabled={busy||!!attempt.current} value={modelId} onChange={e=>setModelId(e.target.value)}>{models.map(m=><option key={m.modelId} value={m.modelId}>{m.displayName} · {m.hostedBy}</option>)}</select></label>
   <p className="text-ui-sm text-ink-2">将{attempt.current?'本次固定的':'上方选中的'} {disclosedTasks.length} 个任务的原始章节或讨论摘录、关联结果及作者反馈发送给{selected?` ${selected.hostedBy} 的 ${selected.displayName}`:'所选模型'}，按实际用量计费。每次选择 1–4 个任务，长来源会注明截断。</p>
   <p className="text-ui-sm text-ink-2">模型会同时比较当前可检索的已确认经验，并只给出关系建议。</p>
   <Btn disabled={busy||!modelId||disclosedTasks.length<1||disclosedTasks.length>4} onClick={()=>void perform(start)}>{attempt.current?'继续本次请求':'同意发送并提取'}</Btn>
   {attempt.current&&<Btn disabled={busy} onClick={()=>void perform(async()=>{const current=attempt.current;if(current?.sessionId){const value=await api.get(bookId,current.sessionId);if(alive.current)setSession(value)}else{attempt.current=undefined}})}>{attempt.current.sessionId?'查看本次执行':'重新选择'}</Btn>}
  </>}
  {previous.length>0&&!running&&<label className="block">已有提取<select aria-label="已有提取" className="ml-2 max-w-full rounded border border-line-soft bg-paper p-2" value={session?.sessionId??''} disabled={busy} onChange={e=>{const selected=e.target.value;if(selected)void perform(async()=>{const current=await api.get(bookId,selected);if(alive.current)setSession(current)})}}><option value="">选择执行记录</option>{previous.map(p=><option key={p.sessionId} value={p.sessionId}>{p.title}</option>)}</select></label>}
  {session&&<>
   {comparisonBinding&&<p className="text-ui-sm text-ink-2">本次比较了 {disclosedComparisons} 条已确认经验{comparisonBinding.comparisonOmitted?`，另有 ${comparisonBinding.comparisonOmitted} 条因数量上限未比较`:''}。关系建议需要你判断。</p>}
   <p role="status">{running?'正在提取经验…':complete?'提取完成，保存后仍需单独确认。':session.run?.failure?.message??'本次提取已停止。'}</p>
   {result?.role==='assistant'&&candidate&&<p className="whitespace-pre-wrap break-words text-ui-sm">{candidate}</p>}
   {complete&&!candidate&&<p className="text-warn">模型未返回有效候选，请查看来源后重新提取。</p>}
   <div className="flex flex-wrap gap-3">
    {running&&<Btn disabled={busy} onClick={()=>void perform(async()=>{await api.cancel(bookId,session.sessionId);const current=await api.get(bookId,session.sessionId);if(alive.current)setSession(current)})}>取消提取</Btn>}
    <Btn disabled={busy} onClick={()=>void perform(async()=>{const current=await api.get(bookId,session.sessionId);if(alive.current)setSession(current)})}>刷新执行状态</Btn>
    {complete&&candidate&&<Btn disabled={busy} onClick={()=>void perform(async()=>{await api.memoryCandidate(bookId,session.sessionId,session.run!.runId);await onSaved();if(alive.current)setNotice('已保存为待审核候选，请在下方确认或撤回。')})}>保存提取候选</Btn>}
    {!running&&<Btn disabled={busy} onClick={()=>{attempt.current=undefined;setSession(undefined);setNotice('');setError('')}}>新建提取</Btn>}
   </div>
  </>}
  {error&&<p role="alert" className="text-warn">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
 </div>
}
