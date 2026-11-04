import {spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,statSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {cpus,tmpdir,totalmem} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Store,type Saved} from '../src/sessions/store.js';
import {ThinkingState,durableContext} from '../src/runtime/durable.js';
import type {ThinkingEvent} from '@writer-agent/contracts';

const script=fileURLToPath(import.meta.url);
const sizeArg=process.argv.find(argument=>argument.startsWith('--size='));
const millis=(value:number)=>Math.round(value*1000)/1000;
const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {p50Ms:millis(sorted[Math.floor(sorted.length*.5)]!),p95Ms:millis(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]!)}};
const event=(cursor:number):ThinkingEvent=>({id:cursor,type:'text_delta',messageId:'message-199',text:'Synthetic event payload for indexed history measurement. '.repeat(3)});
const measure=(action:()=>unknown,count=50)=>{const timings:number[]=[];for(let i=0;i<count;i++){const started=performance.now();action();timings.push(performance.now()-started)}return stats(timings)};
const sumBytes=(files:Record<string,number>)=>Object.values(files).reduce((total,bytes)=>total+bytes,0);
const files=(directory:string)=>Object.fromEntries(readdirSync(directory).filter(name=>name.includes('.sqlite')).map(name=>[name.replace(/^th-[a-f0-9-]+\./,'session.'),statSync(join(directory,name)).size]));
if(sizeArg){
 const count=Number(sizeArg.slice(7));
 if(![1000,10000,100000].includes(count))throw Error('Expected 1000, 10000 or 100000 events');
 const directory=mkdtempSync(join(tmpdir(),'thinking-storage-benchmark-')),id='th-'+randomUUID();
 global.gc?.();const memoryBefore=process.memoryUsage();
 let store=new Store(directory);let cursor=0;
 try{
  await store.ready;
  const saved:Saved={schema:1,accountingVersion:2,owner:'synthetic-author',entries:[],events:[],requests:{},view:{sessionId:id,bookId:'synthetic-book',title:'Benchmark',createdAt:'now',model:{provider:'fixture',model:'synthetic',endpoint:'https://example.invalid',protocol:'thinking-v1',limits:{maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:1000,maxOutputTokens:100,maxSessionTokens:2000,maxConcurrentSessions:1,maxDurationMs:10000,maxToolResultBytes:1000}},scopes:[],status:'idle',messages:Array.from({length:200},(_,i)=>({id:'message-'+i,role:i%2?'assistant':'user',text:'Synthetic visible discussion. '.repeat(32),status:'completed',sources:[],createdAt:'now'})),cursor:0,usage:{input:0,output:0,charged:0,incomplete:false}}};
  await store.write(saved);
  const emptyFiles=files(directory);
  const loadingStarted=performance.now();
  for(let start=0;start<count;start+=1000){saved.events=Array.from({length:Math.min(1000,count-start)},(_,offset)=>event(start+offset+1));saved.view.cursor=start+saved.events.length;await store.write(saved)}
  const loadMs=millis(performance.now()-loadingStarted);cursor=count;
  const beforeAppendFiles=files(directory),appendTimings:number[]=[];
  for(let i=0;i<20;i++){
   const started=performance.now();
   const next=store.state(id)!;next.events=[event(++cursor)];next.view.cursor=cursor;
   await store.write(next);appendTimings.push(performance.now()-started);
  }
  const recent100=measure(()=>store.readEvents(id,cursor-100,100));
  const historyPage200=measure(()=>store.readEvents(id,Math.floor(count/2),200));
  const snapshot40=measure(()=>store.snapshot(id,40));
  const messageHistory80=measure(()=>store.history(id,'message-160',80));
  const document=await (await store.harness(id)).snapshot(ThinkingState,durableContext);
  const stateBytes=Buffer.byteLength(JSON.stringify(document));
  global.gc?.();const memoryLoaded=process.memoryUsage();const afterAppendFiles=files(directory);
  await store.close();const closedFiles=files(directory);
  const restartStarted=performance.now();store=new Store(directory);await store.ready;const restartMs=millis(performance.now()-restartStarted);
  const restored=store.snapshot(id,40);if(restored?.cursor!==cursor)throw Error('Benchmark restart lost cursor');
  global.gc?.();const memoryRestarted=process.memoryUsage();
  console.log(JSON.stringify({events:count,finalCursor:cursor,loadBatchSize:1000,loadMs,append20:stats(appendTimings),recent100,historyPage200,snapshot40,messageHistory80,stateBytes,emptyFiles,beforeAppendFiles,afterAppendFiles,closedFiles,loadGrowthBytes:sumBytes(beforeAppendFiles)-sumBytes(emptyFiles),appendGrowthBytes:sumBytes(afterAppendFiles)-sumBytes(beforeAppendFiles),restartMs,memoryBefore:{rss:memoryBefore.rss,heapUsed:memoryBefore.heapUsed},memoryLoaded:{rss:memoryLoaded.rss,heapUsed:memoryLoaded.heapUsed},memoryRestarted:{rss:memoryRestarted.rss,heapUsed:memoryRestarted.heapUsed}}));
 }finally{await store.close();rmSync(directory,{recursive:true,force:true})}
}else{
 const results=[];
 for(const count of [1000,10000,100000]){
  const run=spawnSync(process.execPath,['--expose-gc','--import',import.meta.resolve('tsx'),script,'--size='+count],{encoding:'utf8',maxBuffer:4*1024*1024});
  if(run.status!==0)throw Error(run.stderr||run.stdout||'Benchmark child failed');
  results.push(JSON.parse(run.stdout.trim().split('\n').at(-1)!));
 }
 const output=resolve(dirname(script),'../../../.local/benchmarks');mkdirSync(output,{recursive:true});
 const metadata={node:process.version,platform:process.platform,architecture:process.arch,cpu:cpus()[0]?.model,totalMemoryBytes:totalmem(),recordedAt:new Date().toISOString(),method:'Fresh process per history size; synthetic 200-message session; 1000-event load batches; 20 single-event append samples; 50 query samples; FULL synchronous SQLite; explicit GC before memory readings; append durations include event-free state() read, event creation, Store/outbox/projector work. Queries are warm repeated reads; restart uses one close/open per size, without clearing OS page cache. File growth is allocated file length including WAL/SHM, not cumulative write traffic. Memory is GC-settled RSS/heap, not peak RSS. Host process scheduling and disk activity are not isolated.'};
 writeFileSync(join(output,'thinking-storage.json'),JSON.stringify({metadata,results},null,2)+'\n');
 const mib=(n:number)=>(n/1024/1024).toFixed(2);
 const latencyRows=results.map(row=>`| ${row.events.toLocaleString('en-US')} | ${row.append20.p50Ms} / ${row.append20.p95Ms} | ${row.recent100.p50Ms} / ${row.recent100.p95Ms} | ${row.historyPage200.p50Ms} / ${row.historyPage200.p95Ms} | ${row.snapshot40.p50Ms} / ${row.snapshot40.p95Ms} | ${row.messageHistory80.p50Ms} / ${row.messageHistory80.p95Ms} | ${row.restartMs} |`).join('\n');
 const capacityRows=results.map(row=>`| ${row.events.toLocaleString('en-US')} | ${row.stateBytes} | ${mib(sumBytes(row.afterAppendFiles))} | ${mib(row.loadGrowthBytes)} | ${row.appendGrowthBytes} | ${mib(sumBytes(row.closedFiles))} | ${mib(row.memoryLoaded.rss)} / ${mib(row.memoryLoaded.heapUsed)} | ${mib(row.memoryRestarted.rss)} / ${mib(row.memoryRestarted.heapUsed)} |`).join('\n');
 const text=`# Thinking 分层存储基准\n\n环境：${metadata.node}，${metadata.platform}/${metadata.architecture}，${metadata.cpu}。\n\n运行命令：\`pnpm --filter @writer-agent/agent exec tsx scripts/benchmark-thinking-storage.ts\`。\n\n每种规模使用独立进程、200 条固定合成消息和每条约 170 字符的事件。装载批次为 1,000 条；单条追加采样 20 次，查询采样 50 次。追加耗时包含无事件历史的 state() 读取、新事件构造、Durable 事务、事件投影和 outbox 确认。所有查询均为装载后重复读取。未隔离宿主机其他进程调度与磁盘活动，时延包含当次环境波动。重启测量包括关闭后的新 Store 初始化，不清空操作系统页缓存；每组只测量一次重启。内存数据在显式 GC 后读取，表示稳定占用而非峰值。未调用外部模型。\n\n延迟为 p50 / p95，单位毫秒。\n\n| 初始事件数 | 单条追加 | 最近 100 事件 | 历史页 200 事件 | 快照 40 消息 | 消息历史页 80 | 重启 ms |\n| --- | --- | --- | --- | --- | --- | --- |\n${latencyRows}\n\n文件大小按实际分配长度统计，运行中总量包含 SQLite、WAL 和 SHM；装载增长以空会话为基线；追加增长是连续 20 次追加的文件长度差，可能因 WAL 复用而为零，不表示没有磁盘写入。关闭后总量为 checkpoint 后的数据库文件。内存列为 RSS / Heap，单位 MiB。\n\n| 初始事件数 | State bytes | 运行中 SQLite MiB | 装载增长 MiB | 20 次追加增长 bytes | 关闭后 SQLite MiB | 装载后 RSS / Heap MiB | 重启后 RSS / Heap MiB |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${capacityRows}\n\n每组测量后 cursor 为初始事件数加 20，重启检查一致。文件明细、装载耗时和原始内存值见 thinking-storage.json。结果仅代表该机器、固定消息大小和合成事件负载；样本量有限，不包含模型、Go API、多会话竞争、冷缓存或不同存储设备，也不用于估算生产 SLA 或峰值内存。\n`;
 writeFileSync(join(output,'thinking-storage.md'),text);console.log(text);console.log('Saved '+join(output,'thinking-storage.json'));
}
