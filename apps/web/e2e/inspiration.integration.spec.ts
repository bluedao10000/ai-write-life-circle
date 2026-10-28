import {test,expect} from '@playwright/test'
test('first send, model switch, refresh and private scope settings are natural',async({page})=>{
 await page.goto('/studio?view=inspire')
 const input=page.getByRole('textbox',{name:'说说你的想法'})
 await expect(input).toBeVisible()
 await expect(page.getByRole('combobox',{name:'选择对话模型'})).toHaveValue('deepseek')
 await input.fill('我想以张居正为原型，讨论好人品与平行宇宙。')
 await page.getByRole('button',{name:'发送',exact:true}).click()
 await expect(page.getByRole('dialog',{name:/确认.*讨论/})).toHaveCount(0)
 await expect(page.getByText('可以从权力、责任和代价讨论人物的选择。这些只是创作建议，不是正式设定。',{exact:true})).toBeVisible({timeout:20000})
 await expect(input).toHaveValue('')
 await page.getByRole('combobox',{name:'选择对话模型'}).selectOption('gpt-oss')
 await input.fill('再从另一个视角讨论。')
 await page.getByRole('button',{name:'发送',exact:true}).click()
 await expect(page.getByText('OpenAI · GPT-OSS 120B',{exact:true})).toBeVisible({timeout:20000})
 await input.fill('尚未发送的想法')
 await page.reload()
 await expect(input).toHaveValue('尚未发送的想法')
 await expect(page.locator('ol').getByText('我想以张居正为原型，讨论好人品与平行宇宙。',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'AI 资料范围',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'本作品的 AI 资料范围'})
 await expect(dialog.getByRole('checkbox',{name:'私人作者笔记（额外授权）'})).not.toBeChecked()
 await dialog.getByRole('checkbox',{name:'本作品知识库'}).check()
 await dialog.getByRole('button',{name:'保存范围'}).click()
 await page.getByRole('button',{name:'AI 资料范围',exact:true}).click()
 await expect(dialog.getByRole('checkbox',{name:'本作品知识库'})).toBeChecked()
 await expect(dialog.getByRole('checkbox',{name:'私人作者笔记（额外授权）'})).not.toBeChecked()
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})

test('A → B → A sends the model owned by each conversation', async({page,request},testInfo)=>{
 await page.goto('/studio?view=inspire')
 const input=page.getByRole('textbox',{name:'说说你的想法'}), model=page.getByRole('combobox',{name:'选择对话模型'})
 const history=async()=>{if((page.viewportSize()?.width??1440)<1024) await page.getByRole('button',{name:'创作探索记录',exact:true}).click();await expect(page.getByRole('button',{name:'新话题',exact:true})).toBeVisible()}
 const fresh=async()=>{await history();await page.getByRole('button',{name:'新话题',exact:true}).click()}
 const send=async(text:string,expected:string)=>{
  await input.fill(text)
  const sent=page.waitForRequest(r=>r.method()==='POST' && /\/thinking\/sessions\/[^/]+\/messages$/.test(new URL(r.url()).pathname))
  await page.getByRole('button',{name:'发送',exact:true}).click()
  const req=await sent
  expect(req.postDataJSON().modelId).toBe(expected)
  await expect(input).toHaveValue('');await expect(model).toBeEnabled()
  const path=new URL(req.url()).pathname.replace(/\/messages$/,'')
  const snapshot=await (await request.get(path)).json()
  expect(snapshot.messages.filter((m:{role:string})=>m.role==='user').at(-1).modelId).toBe(expected)
  return path
 }
 const titleA=`模型隔离 A ${testInfo.project.name}`, titleB=`模型隔离 B ${testInfo.project.name}`
 await fresh();await model.selectOption('deepseek');const a=await send(titleA,'deepseek')
 await fresh();await model.selectOption('gpt-oss');await send(titleB,'gpt-oss')
 await history();await page.getByRole('button',{name:new RegExp(`^${titleA} `)}).first().click()
 await expect(model).toHaveValue('deepseek')
 expect(await send('回到 A 继续','deepseek')).toBe(a)
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
 await page.goto('/studio?view=inspire')
 const input=page.getByRole('textbox',{name:'说说你的想法'}),model=page.getByRole('combobox',{name:'选择对话模型'})
 const history=async()=>{if((page.viewportSize()?.width??1440)<1024) await page.getByRole('button',{name:'创作探索记录',exact:true}).click();await expect(page.getByRole('button',{name:'新话题',exact:true})).toBeVisible()}
 await history();await page.getByRole('button',{name:'新话题',exact:true}).click()
 await expect(model).toHaveValue('deepseek');await input.fill(titleA);await page.getByRole('button',{name:'发送',exact:true}).click()
 await expect(page.getByRole('button',{name:'恢复待确认问题'})).toBeVisible()
 await expect(model).toBeEnabled()
 await expect.poll(async()=> (await (await request.get(aPath)).json()).status).toBe('idle')
 const before=await (await request.get(aPath)).json()
 const outboxKey=`thinking-outbox:${aPath.split('/')[4]}`,id=aPath.split('/').at(-1)!
 const readKey=()=>page.evaluate(({key,id})=>JSON.parse(sessionStorage.getItem(key)??'{}').pending?.[id]?.key,{key:outboxKey,id})
 expect(await readKey()).toBe(keys[0])
 await history();await page.getByRole('button',{name:'新话题',exact:true}).click()
 await input.fill(`正常 B ${testInfo.project.name}`);await page.getByRole('button',{name:'发送',exact:true}).click()
 await expect(input).toHaveValue('');await expect(model).toBeEnabled()
 expect(await readKey()).toBe(keys[0])
 await page.reload();await expect(input).toBeVisible()
 await history();await page.getByRole('button',{name:new RegExp(`^${titleA} `)}).first().click()
 await expect(page.getByRole('button',{name:'恢复待确认问题'})).toBeVisible()
 expect(await readKey()).toBe(keys[0])
 mask=false
 await page.getByRole('button',{name:'恢复待确认问题'}).click();await expect(input).toHaveValue(titleA)
 await page.getByRole('button',{name:'发送',exact:true}).click();await expect(input).toHaveValue('')
 expect(keys).toHaveLength(1)
 const after=await (await request.get(aPath)).json()
 expect(after.messages.filter((m:{role:string})=>m.role==='user')).toHaveLength(1)
 expect(after.usage).toEqual(before.usage)
})
