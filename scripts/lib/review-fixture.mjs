import {syntheticOutput} from './knowledge-fixture.mjs'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
export const cases = JSON.parse(await readFile(new URL('../../harness/evals/review-agent/cases.json', import.meta.url), 'utf8'))
export async function createReviewFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'writer-review-fixture-'))
  const harness = join(directory, 'harness'), state = join(directory, 'state')
  await mkdir(join(harness, 'manuscript'), { recursive: true })
  let mode = 'valid', calls = 0
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
    if (req.url === '/stats') { res.end(JSON.stringify({ calls })); return }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
    calls++
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
 requests.push(request)
    let input;try{input=JSON.parse(request.messages.find((m)=>m.role==='user').content)}catch{input=null}
 if(input?.targetMarkdown!==undefined){
 const selected=mode;if(selected==='knowledge-slow'||selected==='knowledge-timeout')await new Promise(r=>setTimeout(r,selected==='knowledge-timeout'?2500:1800));
 const content=JSON.stringify(selected==='knowledge-empty'?{entities:[],assertions:[]}:syntheticOutput(input));
 if(request.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'knowledge',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],...(selected==='usage-missing'?{}:{usage:{prompt_tokens:150,completion_tokens:100}})})+'\n\ndata: [DONE]\n\n');return}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:150,completion_tokens:100}}));return
 }
 if(!input?.sources){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'thinking',object:'chat.completion.chunk',model:request.model,choices:[{index:0,delta:{role:'assistant',content:'合成思考回复'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\ndata: [DONE]\n\n');return}
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
  return { directory, harness, state, origin, requests, select, get calls() { return calls },
    async sourceBytes() { return Promise.all(['CH-003', 'CH-008'].map((id) => readFile(join(harness, `manuscript/${id}.md`), 'utf8'))) },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }) },
  }
}
