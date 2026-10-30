// Opt-in synthetic smoke. Never reads author manuscripts or production state.
import { startThinkingFixture, seedThinkingBook } from './lib/thinking-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
if (!process.argv.includes('--live') || !process.argv.includes('--confirm-fixtures'))
  throw Error('Requires --live --confirm-fixtures; up to 45 synthetic model requests plus bounded summaries');
const fixture = await startThinkingFixture({live:true,maxOutputTokens:512});
const report={synthetic:true,qualityValidated:false,turns:[],realLLMCalled:true};
try {
  const book=await seedThinkingBook(fixture);
  const base=`/v1/studio/books/${book.bookId}/thinking`;
  const model=await fixture.call(base+'/capabilities');
  const session=await fixture.call(base+'/sessions',{method:'POST',status:201,key:'context-smoke',body:{consent:true,model,scopes:[]}});
  const path=base+'/sessions/'+session.sessionId;
  for(let turn=0;turn<45;turn++) {
    await fixture.call(path+'/messages',{method:'POST',status:202,key:'context-'+turn,body:{text:`合成小说讨论第${turn+1}轮。作者已决定林舟不改姓；父亲失踪原因未定，背叛只是猜测。请继续核对这一动机，不要确定尚未决定的设定。`}});
    let view;
    for(let poll=0;poll<2400;poll++) {view=await fixture.call(path);if(view.status==='idle')break;await delay(50)}
    const answer=view?.messages.at(-1);
    report.turns.push({turn,status:answer?.status,error:answer?.errorCode,usage:view?.usage});
    await mkdir('.local/evals/context-management',{recursive:true});
    await writeFile('.local/evals/context-management/live-smoke.json',JSON.stringify(report,null,2),{mode:0o600});
    if(answer?.status!=='completed')throw Error('Synthetic long-context smoke incomplete; inspect private report');
    if((view.usage?.charged??0)>=50000)throw Error('Synthetic smoke total token ceiling reached');
  }
} finally {await fixture.close()}
