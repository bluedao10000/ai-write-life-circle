import {test,expect,type Page,type APIRequestContext} from '@playwright/test'
// Real Go + Pi processes with a synthetic model HTTP fixture (see start-inspiration-stack.mjs).
// Desktop Chromium and iPhone WebKit run every scenario.
const QUESTION='我想讨论一个问题，什么样的人品才是真正的好人品。我想以明朝的张居正为原型，写一部背景是平行宇宙的科幻小说。'
const SHORT='可以先抓住一个具体的选择：让人物在私德与公共责任冲突时，先背叛哪一个？这个问题本身就是故事的引擎。'
const FAIL_ONCE='【模拟模型故障】'
const narrow=(page:Page)=>(page.viewportSize()?.width??1440)<768
const composer=(page:Page)=>page.getByRole('textbox',{name:'说说你正在思考的问题'})
const picker=(page:Page)=>page.getByRole('button',{name:/^选择回复模型/})
const send=(page:Page)=>page.getByRole('button',{name:'发送',exact:true})
const replies=(page:Page)=>page.getByRole('article',{name:'创作伙伴的回复'})
async function open(page:Page){await page.goto('/studio?view=inspire');await expect(composer(page)).toBeVisible()}
async function chooseModel(page:Page,name:RegExp){
 await picker(page).click()
 const menu=narrow(page)?page.getByRole('dialog',{name:'选择回复模型'}):page.getByRole('group',{name:'选择回复模型'})
 await menu.getByRole('button',{name}).click()
 await expect(menu).toHaveCount(0)
}
async function history(page:Page){if(narrow(page)) await page.getByRole('button',{name:'历史会话与导航',exact:true}).click();await expect(page.getByRole('navigation',{name:'历史会话'})).toBeVisible()}
async function newChat(page:Page){await page.getByRole('button',{name:'新对话',exact:true}).first().click();await expect(page.getByRole('heading',{name:/每一个故事/})).toBeVisible()}
async function moreMenu(page:Page,item:RegExp){await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('group',{name:'更多'}).getByRole('button',{name:item}).click()}
async function sendAndWait(page:Page,text:string,expected:string|RegExp){
 const before=await replies(page).count()
 await composer(page).fill(text)
 await send(page).click()
 await expect(replies(page)).toHaveCount(before+1,{timeout:20000})
 await expect(replies(page).last()).toContainText(expected,{timeout:20000})
 await expect(replies(page).last().getByRole('button',{name:'复制',exact:true})).toBeVisible({timeout:20000})
 await expect(composer(page)).toHaveValue('')
}
// The reliability header opts into run/failure details, exactly like the web client.
const snapshotOf=async(request:APIRequestContext,path:string)=>(await request.get(path,{headers:{'x-writer-agent-thinking':'reliability-v1'}})).json()
const sessionPath=(url:string)=>new URL(url).pathname.replace(/\/(messages|resume|cancel)$/,'')

test('first send creates the conversation without any consent dialog, then models switch per message',async({page,request})=>{
 await open(page)
 await expect(picker(page)).toHaveAccessibleName(/当前为 DeepSeek/)
 await expect(page.getByRole('heading',{name:/每一个故事/})).toBeVisible()
 const sent=page.waitForRequest(r=>r.method()==='POST' && /\/thinking\/sessions\/[^/]+\/messages$/.test(new URL(r.url()).pathname))
 await composer(page).fill(QUESTION)
 await send(page).click()
 await expect(page.getByRole('dialog')).toHaveCount(0)
 const request1=await sent
 expect(Object.keys(request1.postDataJSON()).sort()).toEqual(['modelId','text'])
 const answer=replies(page).last()
 await expect(answer.getByRole('heading',{name:'三把不同的尺子'})).toBeVisible({timeout:20000})
 await expect(answer.locator('blockquote')).toContainText('言必信')
 await expect(answer.getByRole('button',{name:'复制',exact:true})).toBeVisible({timeout:20000})
 await expect(answer).toContainText('DeepSeek')
 await expect(composer(page)).toHaveValue('')
 // No tool loop and no budget failure: an ordinary creative question is one model call.
 const path=sessionPath(request1.url())
 const first=await snapshotOf(request,path)
 expect(first.messages.at(-1)).toMatchObject({role:'assistant',status:'completed',modelId:'deepseek'})
 expect(first.run).toMatchObject({status:'completed',modelCalls:1})
 expect(first.usage.input).toBeGreaterThan(0);expect(first.usage.output).toBeGreaterThan(0);expect(first.usage.incomplete).toBe(false)
 await chooseModel(page,/^OpenAI · GPT-OSS 120B/)
 await expect(picker(page)).toHaveAccessibleName(/当前为 OpenAI · GPT-OSS 120B/)
 await sendAndWait(page,'再从另一个视角讨论。',SHORT)
 await expect(replies(page).last()).toContainText('OpenAI · GPT-OSS 120B')
 const second=await snapshotOf(request,path)
 expect(second.messages.filter((m:{role:string})=>m.role==='user').map((m:{modelId:string})=>m.modelId)).toEqual(['deepseek','gpt-oss'])
 expect(second.messages[1].modelLabel).toBe('DeepSeek')
 // Unsent drafts and the conversation survive a reload.
 await composer(page).fill('尚未发送的想法')
 await page.reload()
 await expect(composer(page)).toHaveValue('尚未发送的想法')
 await expect(page.getByText(QUESTION,{exact:true})).toBeVisible()
 await expect(picker(page)).toHaveAccessibleName(/当前为 OpenAI · GPT-OSS 120B/)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})

test('AI 资料范围 is explicit, per work, revocable, and private notes stay off',async({page})=>{
 await open(page)
 await moreMenu(page,/^AI 资料范围/)
 const dialog=page.getByRole('dialog',{name:'本作品的 AI 资料范围'})
 await expect(dialog.getByRole('checkbox',{name:/私人作者笔记（额外授权）/})).not.toBeChecked()
 await dialog.getByRole('checkbox',{name:/本作品知识库/}).check()
 await dialog.getByRole('button',{name:'保存范围'}).click()
 await expect(dialog).toHaveCount(0)
 await moreMenu(page,/^AI 资料范围 · 已开启 1 项/)
 await expect(dialog.getByRole('checkbox',{name:/本作品知识库/})).toBeChecked()
 await expect(dialog.getByRole('checkbox',{name:/私人作者笔记/})).not.toBeChecked()
 await dialog.getByRole('checkbox',{name:/本作品知识库/}).uncheck()
 await dialog.getByRole('button',{name:'保存范围'}).click()
 await moreMenu(page,/^AI 资料范围 · 仅限对话内容/)
 await page.keyboard.press('Escape')
 await expect(dialog).toHaveCount(0)
})

test('ten rounds in a row keep every message, with no consent prompts and no duplicates',async({page,request},testInfo)=>{
 await open(page);await newChat(page)
 const sent=page.waitForRequest(r=>r.method()==='POST' && /\/messages$/.test(new URL(r.url()).pathname))
 await sendAndWait(page,`十轮讨论 ${testInfo.project.name} 第 1 轮：张居正的好人品`,'三把不同的尺子')
 const path=sessionPath((await sent).url())
 for(let i=2;i<=10;i++) await sendAndWait(page,`第 ${i} 轮：人物的另一种选择`,SHORT)
 const s=await snapshotOf(request,path)
 // The snapshot is a bounded recent page; the total counts every stored message.
 expect(s.history?.totalMessages ?? s.messages.length).toBe(20)
 expect(s.messages.filter((m:{status:string})=>m.status!=='completed')).toEqual([])
 await expect(replies(page)).toHaveCount(10)
 // After a reload only the recent page is loaded; older turns come back on demand.
 await page.reload()
 if(s.history?.hasMore){
  await page.getByRole('button',{name:'加载更早的讨论'}).click()
  await expect(page.getByText(`十轮讨论 ${testInfo.project.name} 第 1 轮：张居正的好人品`,{exact:true})).toBeVisible()
 }
 await expect(replies(page)).toHaveCount(10)
})

test('A → B → A sends the model owned by each conversation', async({page,request},testInfo)=>{
 await open(page)
 const sendTo=async(text:string,expected:string)=>{
  await composer(page).fill(text)
  const sent=page.waitForRequest(r=>r.method()==='POST' && /\/thinking\/sessions\/[^/]+\/messages$/.test(new URL(r.url()).pathname))
  await send(page).click()
  const req=await sent
  expect(req.postDataJSON().modelId).toBe(expected)
  await expect(composer(page)).toHaveValue('');await expect(picker(page)).toBeEnabled({timeout:20000})
  const path=sessionPath(req.url())
  expect((await snapshotOf(request,path)).messages.filter((m:{role:string})=>m.role==='user').at(-1).modelId).toBe(expected)
  return path
 }
 const titleA=`模型隔离 A ${testInfo.project.name}`, titleB=`模型隔离 B ${testInfo.project.name}`
 await newChat(page);await chooseModel(page,/^DeepSeek/);const a=await sendTo(titleA,'deepseek')
 await newChat(page);await chooseModel(page,/^OpenAI/);await sendTo(titleB,'gpt-oss')
 await history(page);await page.getByRole('navigation',{name:'历史会话'}).getByRole('button',{name:new RegExp(`^${titleA}`)}).first().click()
 await expect(picker(page)).toHaveAccessibleName(/当前为 DeepSeek/)
 expect(await sendTo('回到 A 继续','deepseek')).toBe(a)
})

test('stop keeps the partial reply and the question; refresh during a reply recovers it',async({page,request})=>{
 await open(page);await newChat(page)
 await composer(page).fill('请详细谈谈张居正与好人品，我要停止这一轮。')
 const sent=page.waitForRequest(r=>r.method()==='POST' && /\/messages$/.test(new URL(r.url()).pathname))
 await send(page).click()
 const path=sessionPath((await sent).url())
 await page.getByRole('button',{name:'停止回复'}).click({timeout:15000})
 await expect(page.getByText('已停止回复。')).toBeVisible({timeout:15000})
 await expect(page.getByRole('button',{name:'重新提问'})).toBeVisible()
 const stopped=await snapshotOf(request,path)
 expect(stopped.messages.at(-1)).toMatchObject({role:'assistant',status:'cancelled'})
 await page.getByRole('button',{name:'重新提问'}).click()
 await expect(composer(page)).toHaveValue('请详细谈谈张居正与好人品，我要停止这一轮。')
 // Refresh while the next reply streams: the server keeps generating and the page catches up.
 await composer(page).fill('张居正的好人品，再完整说一遍。')
 await send(page).click()
 await expect(page.getByRole('button',{name:'停止回复'})).toBeVisible({timeout:15000})
 await page.reload()
 await expect(replies(page).last()).toContainText('判断的标准由你来定',{timeout:25000})
 const done=await snapshotOf(request,path)
 expect(done.messages.filter((m:{role:string})=>m.role==='user')).toHaveLength(2)
 expect(done.messages.at(-1)).toMatchObject({status:'completed'})
})

test('a provider failure keeps the question, explains it in Chinese, and 重新尝试 resumes the same message',async({page,request},testInfo)=>{
 await open(page);await newChat(page)
 const text=`${FAIL_ONCE} 恢复测试 ${testInfo.project.name}`
 await composer(page).fill(text)
 const sent=page.waitForRequest(r=>r.method()==='POST' && /\/messages$/.test(new URL(r.url()).pathname))
 await send(page).click()
 const path=sessionPath((await sent).url())
 await expect(page.getByText('这次回复未能完成，你的问题已保存。')).toBeVisible({timeout:20000})
 await expect(page.getByText('模型暂时不可用，对话已保留。')).toBeVisible()
 await page.getByRole('button',{name:'查看详情'}).click()
 await expect(page.getByText(/技术详情：PROVIDER_UNAVAILABLE · 追踪编号 [0-9a-f-]{36}/)).toBeVisible()
 const resumed=page.waitForRequest(r=>r.method()==='POST' && /\/resume$/.test(new URL(r.url()).pathname))
 await page.getByRole('button',{name:'重新尝试'}).click()
 expect((await resumed).postDataJSON()).toMatchObject({confirmAdditionalCost:true})
 await expect(replies(page).last()).toContainText(SHORT,{timeout:20000})
 await expect(page.getByText('这次尝试没有完成，已在下方重新回复。')).toBeVisible()
 const s=await snapshotOf(request,path)
 expect(s.messages.filter((m:{role:string})=>m.role==='user')).toHaveLength(1)
 expect(s.messages.at(-1)).toMatchObject({status:'completed'})
})

test('offline send keeps the draft, explains the problem, and the retry creates exactly one conversation',async({page,request,context},testInfo)=>{
 await open(page);await newChat(page)
 const text=`断网重试 ${testInfo.project.name}`
 await composer(page).fill(text)
 await context.setOffline(true)
 await send(page).click()
 await expect(page.getByRole('status').filter({hasText:/输入已保留|连接中断|暂时无法/})).toBeVisible({timeout:15000})
 await expect(composer(page)).toHaveValue(text)
 await context.setOffline(false)
 await expect(send(page)).toBeEnabled({timeout:20000})
 const sent=page.waitForRequest(r=>r.method()==='POST' && /\/messages$/.test(new URL(r.url()).pathname))
 await send(page).click()
 const path=sessionPath((await sent).url())
 await expect(replies(page).last()).toContainText(SHORT,{timeout:20000})
 const list=await (await request.get(path.replace(/\/[^/]+$/,''))).json()
 expect(list.items.filter((s:{title:string})=>s.title===text)).toHaveLength(1)
 expect((await snapshotOf(request,path)).messages.filter((m:{role:string})=>m.role==='user')).toHaveLength(1)
})

test('lost A acknowledgement survives B, reload, and receipt reconciliation without another send', async({page,request},testInfo)=>{
 let aPath='', first=true, mask=true
 const keys:string[]=[]
 const titleA=`待确认 A ${testInfo.project.name}`
 await page.route(/\/thinking\/sessions\/[^/]+\/messages$/,async route=>{
  if(route.request().postDataJSON().text===titleA){
   keys.push(route.request().headers()['idempotency-key'])
   if(first){first=false;aPath=new URL(route.request().url()).pathname.replace(/\/messages$/,'');await route.fetch();await route.abort('failed');return}
  }
  await route.continue()
 })
 await page.route(/\/thinking\/sessions\/[^/]+$/,async route=>{
  if(route.request().method()==='GET' && new URL(route.request().url()).pathname===aPath && mask){
   const response=await route.fetch(),body=await response.json()
   body.messages=body.messages.map((m:Record<string,unknown>)=>{const copy={...m};delete copy.requestKey;return copy})
   await route.fulfill({response,json:body});return
  }
  await route.continue()
 })
 await open(page);await newChat(page)
 await expect(picker(page)).toHaveAccessibleName(/当前为 DeepSeek/);await composer(page).fill(titleA);await send(page).click()
 await expect(page.getByRole('button',{name:'恢复待确认问题'})).toBeVisible()
 await expect(picker(page)).toBeEnabled()
 await expect.poll(async()=> (await snapshotOf(request,aPath)).status).toBe('idle')
 const before=await snapshotOf(request,aPath)
 const outboxKey=`thinking-outbox:${aPath.split('/')[4]}`,id=aPath.split('/').at(-1)!
 const readKey=()=>page.evaluate(({key,id})=>JSON.parse(sessionStorage.getItem(key)??'{}').pending?.[id]?.key,{key:outboxKey,id})
 expect(await readKey()).toBe(keys[0])
 await newChat(page)
 await composer(page).fill(`正常 B ${testInfo.project.name}`);await send(page).click()
 await expect(composer(page)).toHaveValue('');await expect(picker(page)).toBeEnabled({timeout:20000})
 expect(await readKey()).toBe(keys[0])
 await page.reload();await expect(composer(page)).toBeVisible()
 await history(page);await page.getByRole('navigation',{name:'历史会话'}).getByRole('button',{name:new RegExp(`^${titleA}`)}).first().click()
 await expect(page.getByRole('button',{name:'恢复待确认问题'})).toBeVisible()
 expect(await readKey()).toBe(keys[0])
 mask=false
 await page.getByRole('button',{name:'恢复待确认问题'}).click();await expect(composer(page)).toHaveValue(titleA)
 await send(page).click();await expect(composer(page)).toHaveValue('')
 expect(keys).toHaveLength(1)
 const after=await snapshotOf(request,aPath)
 expect(after.messages.filter((m:{role:string})=>m.role==='user')).toHaveLength(1)
 expect(after.usage).toEqual(before.usage)
})

test('mobile and desktop chrome: no overflow, composer never covers the reply, layers close',async({page})=>{
 await open(page)
 const noOverflow=()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)
 expect(await noOverflow()).toBe(true)
 // 16px input text prevents iOS Safari from zooming on focus.
 expect(await composer(page).evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
 await sendAndWait(page,QUESTION,'三把不同的尺子')
 const scroller=page.locator('main[aria-label="灵感对话"] .overflow-y-auto').first()
 await scroller.evaluate(el=>el.scrollTo({top:el.scrollHeight}))
 const last=page.getByRole('article',{name:'创作伙伴的回复'}).last().getByRole('button',{name:'复制',exact:true})
 const box=await last.boundingBox(),dock=await composer(page).boundingBox()
 expect(box&&dock&&box.y+box.height<=dock.y).toBeTruthy()
 // Model sheet / menu stays inside the viewport and closes.
 await picker(page).click()
 const sheet=narrow(page)?page.getByRole('dialog',{name:'选择回复模型'}):page.getByRole('group',{name:'选择回复模型'})
 const s=await sheet.boundingBox(),vp=page.viewportSize()!
 expect(s&&s.x>=0&&s.y>=0&&s.x+s.width<=vp.width+1&&s.y+s.height<=vp.height+1).toBeTruthy()
 await page.keyboard.press('Escape');await expect(sheet).toHaveCount(0)
 if(narrow(page)){
  await page.getByRole('button',{name:'历史会话与导航',exact:true}).click()
  const drawer=page.getByRole('complementary',{name:'历史会话与导航'})
  await expect(drawer.getByRole('tab',{name:'灵感'})).toBeVisible()
  await drawer.getByRole('button',{name:'关闭',exact:true}).click();await expect(drawer).toHaveCount(0)
 } else {
  await page.getByRole('button',{name:'收起历史会话'}).click()
  await expect(page.getByRole('button',{name:'展开历史会话'})).toBeVisible()
  await page.getByRole('button',{name:'展开历史会话'}).click()
 }
 expect(await noOverflow()).toBe(true)
})
