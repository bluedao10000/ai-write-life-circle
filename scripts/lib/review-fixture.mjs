import {syntheticOutput} from './knowledge-fixture.mjs'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
export const cases = JSON.parse(await readFile(new URL('../../harness/evals/review-agent/cases.json', import.meta.url), 'utf8'))
export async function createReviewFixture({modelBudget}={}) {
  const directory = await mkdtemp(join(tmpdir(), 'writer-review-fixture-'))
  const harness = join(directory, 'harness'), state = join(directory, 'state')
  await mkdir(join(harness, 'manuscript'), { recursive: true })
  let mode = 'valid', calls = 0, reviewCalls = 0, knowledgeResponses = 0, consolidationCalls = 0, planToolAttempts = 0, planToolAttemptName = ''
 const requests=[]
  async function select(value = cases[0]) {
    mode = value.fake
    await writeFile(join(harness, 'manuscript/CH-003.md'), `# 历史记录\nID: CH-003\norder: 3\n\n${value.history}\n`)
    await writeFile(join(harness, 'manuscript/CH-008.md'), `# 当前审查夹具\nID: CH-008\norder: 8\n\n${value.target}\n\n测试编号：${value.id}\n`)
  }
  await select()
  const server = createServer(async (req, res) => {
    if (req.url === '/control' && req.method === 'POST') {
      let data = ''; for await (const chunk of req) data += chunk
      mode = JSON.parse(data).mode; res.end('{}'); return
    }
    if (req.url === '/stats') { res.end(JSON.stringify({ calls, reviewCalls, mode })); return }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
    calls++
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    if(modelBudget&&(calls>modelBudget.maxModelCalls||calls*(100+(request.max_completion_tokens??request.max_tokens??2048))>modelBudget.maxTokens)){
      res.writeHead(429).end('{}');return
    }
 requests.push(request)
 if(request.messages.find(m=>m.role==='system')?.content.includes('You consolidate author-reviewed operating experience')){
  consolidationCalls++
  if(mode==='memory-consolidation-slow')await new Promise(resolve=>setTimeout(resolve,1800));
  const selected=mode,system=request.messages.find(m=>m.role==='system').content,user=request.messages.find(m=>m.role==='user')?.content??'';
  const taskIds=[...new Set([...user.matchAll(/"taskId":"([^"]+)"/g)].map(m=>m[1]))];
  const output=selected==='memory-consolidation-noop'
   ?{content:null,taskIds:[],relations:[]}
   :{content:'适用于内容审查的操作经验：先逐条核对原文证据，再结合作者反馈区分事实、推断与待决问题。完成执行不等于质量已获证明。',taskIds,relations:[]};
  const content=selected==='memory-consolidation-invalid'?'invalid-json':JSON.stringify(output);
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'memory-consolidation',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:120,completion_tokens:70}})+'\n\ndata: [DONE]\n\n');return
 }
 if(request.messages.find(m=>m.role==='system')?.content.includes('You extract a candidate operating method')){
  const selected=mode,system=request.messages.find(m=>m.role==='system').content;
  if(selected==='memory-extract-slow')await new Promise(r=>setTimeout(r,1800));
  const taskIds=[...new Set([...system.matchAll(/"taskId":"([^"]+)"/g)].map(m=>m[1]))];
  const memoryIds=[...new Set([...system.matchAll(/"memoryId":"([^"]+)"/g)].map(m=>m[1]))];
  const relationMode=system.includes('Return only a JSON object with exactly three fields');
  const relations=relationMode&&selected==='memory-relation-foreign'?[{memoryId:'pm-foreign',kind:'conflict',reason:'合成比较：不存在的目标。'}]:relationMode&&selected==='memory-relation'&&memoryIds.length?[{memoryId:memoryIds[0],kind:'conflict',reason:'合成比较：两条方法对当前修订的使用顺序不同。'}]:[];
  const output={content:'适用于对照章节的内容审查：先逐条核对原文证据，再结合作者反馈判断差异。成功执行不代表质量已经验证；需更多独立任务验证适用性。',taskIds:selected==='memory-extract-foreign'?['unselected-task']:taskIds,...(relationMode&&selected!=='memory-extract-missing-relations'?{relations}:{})};
  const content=selected==='memory-extract-invalid'?'invalid-json':JSON.stringify(output);
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'memory-extract',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:80}})+'\n\ndata: [DONE]\n\n');return
 }
 if(request.messages.find(m=>m.role==='system')?.content.startsWith('You organize')){
  const input=JSON.parse(request.messages.find(m=>m.role==='user').content);
  const message=input.conversation.find(m=>m.messageId===input.focusMessageIds[0]);
  const content=JSON.stringify({summary:'合成人物候选',noChange:false,changes:[{ref:'hero',operation:'CREATE',stance:'author_hypothesis',kind:'character',name:'林舟',evidence:[{messageId:message.messageId,quote:message.text}]}]});
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'creative',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:80}})+'\n\ndata: [DONE]\n\n');return
 }
 const system=request.messages.find(m=>m.role==='system')?.content??'';
 const planContent=()=>{
  const raw=JSON.parse(request.messages.find(m=>m.role==='user').content);
  const source=raw.source??raw;
  const checks=source.plans.map((plan)=>({assetId:plan.assetId,assessment:'diverged',quote:'最终选择留下',explanation:'计划要求离开，正文选择了留下。',question:'要修改计划还是调整正文？'}));
  return JSON.stringify({checks});
 };
 if(system.startsWith('You are the planner in a read-only story-plan review')){
  const source=JSON.parse(request.messages.find(m=>m.role==='user').content);
  const content=JSON.stringify({items:source.plans.map((plan)=>({assetId:plan.assetId,focus:'核对计划与正文的差异'}))});
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'creative-planner',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');return
 }
 if(system.startsWith('You are the evidence researcher in a read-only story-plan review')){
  if(mode==='creative-plan-failure'){res.writeHead(503).end('private-provider-message');return}
  if(mode==='creative-plan-tool-attempt'){
   planToolAttempts++;
   planToolAttemptName='record_story_changes';
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'creative-researcher-tool',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'creative-write-attempt',type:'function',function:{name:'record_story_changes',arguments:'{"changes":[{"intent":"explore","patch":{"name":"未授权写入"},"evidence":[{"messageId":"synthetic","quote":"该字段仅是合成越权测试"}]}]}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:200,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');return
  }
  const {source}=JSON.parse(request.messages.find(m=>m.role==='user').content);
  const content=JSON.stringify({findings:source.plans.map((plan)=>({assetId:plan.assetId,quote:'最终选择留下',observation:'正文明确写角色留下。',assessment:'diverged'}))});
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'creative-researcher',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');return
 }
 if(system.startsWith('You are the continuity analyst in a read-only story-plan review')){
  const {source}=JSON.parse(request.messages.find(m=>m.role==='user').content);
  const content=JSON.stringify({analyses:source.plans.map((plan)=>({assetId:plan.assetId,reasoning:'计划的方向与正文相反。',assessment:'diverged'}))});
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'creative-analyst',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');return
 }
 if(system.startsWith('You are the independent critic in a read-only story-plan review')){
  const {source}=JSON.parse(request.messages.find(m=>m.role==='user').content);
  const content=JSON.stringify({concerns:source.plans.map((plan)=>({assetId:plan.assetId,concern:'需要作者确认留下是否为有意选择。'}))});
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'creative-critic',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');return
 }
 if(system.startsWith('You compare an author\'s accepted plans for one chapter')){
  const content=planContent();
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'creative-plan-check',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');return
 }
    let input;try{input=JSON.parse(request.messages.find((m)=>m.role==='user').content)}catch{input=null}
 if(input?.targetMarkdown!==undefined){
 const selected=mode;if(selected==='knowledge-slow'||selected==='knowledge-timeout')await new Promise(r=>setTimeout(r,selected==='knowledge-timeout'?2500:1800));
 knowledgeResponses++;
 const content=JSON.stringify(selected==='knowledge-empty'?{entities:[],assertions:[]}:syntheticOutput(input));
 if(request.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'knowledge',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],...(selected==='usage-missing'?{}:{usage:{prompt_tokens:150,completion_tokens:100}})})+'\n\ndata: [DONE]\n\n');return}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:150,completion_tokens:100}}));return
 }
 if(!input?.sources&&mode==='memory-read'&&!request.messages.some(m=>m.role==='tool')){
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'memory-tool',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'memory-call',type:'function',function:{name:'retrieve_memory',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\ndata: [DONE]\n\n');return
 }
 if(!input?.sources){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'thinking',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content:'合成思考回复'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\ndata: [DONE]\n\n');return}
    reviewCalls++
    const selectedMode = mode
    if (selectedMode === 'slow') await new Promise((resolve) => setTimeout(resolve, 1800))
    if (selectedMode === 'failure') { res.writeHead(503).end('private-provider-message'); return }
    const target = input.sources.find((s) => s.kind === 'target'), history = input.sources.find((s) => s.kind === 'historical_chapter')
    const finding = { type: input.reviewTypes[0], title: '两处记录可能存在差异', inference: 'AI 候选推断：两处记录可能不一致，需要作者核对。', question: '这是有意保留的差异吗？', alternativeExplanation: '也可能是角色认知、时间变化或有意的信息不对称。', evidence: [
      { sourceId: target.sourceId, quote: target.excerpt.trim().split('\n')[0].replace(/^😀/, '') },
      { sourceId: history?.sourceId ?? 'missing', quote: history?.excerpt.trim() ?? 'missing' },
    ] }
    if (selectedMode === 'fake-quote') finding.evidence[0].quote = '这句话不在原文中'
    if (selectedMode === 'fake-source') finding.evidence[1].sourceId = '../../private/secret'
    const content = selectedMode === 'invalid' ? '{invalid' : JSON.stringify({ findings: selectedMode === 'empty' ? [] : [finding] })
    if(request.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'review',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],...(selectedMode==='usage-missing'?{}:{usage:{prompt_tokens:100,completion_tokens:80}})})+'\n\ndata: [DONE]\n\n');return}
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 80 } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { directory, harness, state, origin, requests, select, get calls() { return calls }, get reviewCalls() { return reviewCalls }, get knowledgeResponses(){return knowledgeResponses}, get consolidationCalls(){return consolidationCalls}, get planToolAttempts(){return planToolAttempts}, get planToolAttemptName(){return planToolAttemptName},
    async sourceBytes() { return Promise.all(['CH-003', 'CH-008'].map((id) => readFile(join(harness, `manuscript/${id}.md`), 'utf8'))) },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }) },
  }
}
