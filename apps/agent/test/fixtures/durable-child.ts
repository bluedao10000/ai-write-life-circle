import {readFileSync} from 'node:fs';
import {PiHost} from '../../src/runtime/pi-host.js';
import {Store,type Saved,type ExecutionFence} from '../../src/sessions/store.js';
import type {Tx} from '@earendil-works/pi-durable';
import {server} from '../../src/server/http.js';
import type {Config} from '../../src/config.js';

const config=JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Config;
const host=new PiHost(config,new Store(config.state));
await host.ready;
let loseReceipt=false;
let holdFinal=false;
const write=host.store.write.bind(host.store);
host.store.write=async<T>(value:Saved,mutate?:(tx:Tx)=>T|Promise<T>,fence?:ExecutionFence)=>{
 if(holdFinal&&['completed','failed'].includes(value.view.run?.status??'')&&value.view.status==='idle'){
  process.send?.({event:'final-ready'});
  await new Promise<void>(()=>{});
 }
 return write(value,mutate,fence);
};
const accept=host.accept.bind(host);
host.accept=async(...args)=>{
 const receipt=await accept(...args);
 if(loseReceipt){
  loseReceipt=false;
  process.send?.({event:'accepted',receipt});
  await new Promise<void>(()=>{});
 }
 return receipt;
};
const http=server(host);
await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
process.on('message',async(value:unknown)=>{
 const command=value as {id:number;op:string;sessionId:string};
 try{
  let result:unknown;
  if(command.op==='lose-receipt')loseReceipt=true;
  else if(command.op==='hold-final')holdFinal=true;
  else if(command.op==='settled'){await host.active.get(command.sessionId)?.done;result=host.get(command.sessionId)}
  else if(command.op==='snapshot')result=host.get(command.sessionId);
  else throw Error('UNKNOWN_COMMAND');
  process.send?.({id:command.id,result});
 }catch(error){process.send?.({id:command.id,error:error instanceof Error?error.message:String(error)})}
});
process.send?.({event:'ready',origin:`http://127.0.0.1:${(http.address() as {port:number}).port}`});
