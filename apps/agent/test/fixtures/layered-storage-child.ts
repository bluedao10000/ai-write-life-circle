import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {Store,type Saved} from '../../src/sessions/store.js';
import {EventStore} from '../../src/sessions/event-store.js';

const [directory,sessionId,startupPhase]=process.argv.slice(2);
let armed:string|undefined=startupPhase;
let failProjection=false;
const project=EventStore.prototype.project;
EventStore.prototype.project=function(...args:Parameters<typeof project>){
 if(failProjection)throw Error('SYNTHETIC_SQLITE_WRITE_FAILURE');
 return project.apply(this,args);
};
const store=new Store(directory!,{onPhase:async phase=>{
 if(phase!==armed)return;
 armed=undefined;
 process.send?.({event:'phase',phase});
 await new Promise<void>(()=>{});
}});
await store.ready;
process.on('message',async(input:unknown)=>{
 const command=input as {id:number;op:string;phase?:string;value?:Saved;after?:number};
 try{
  let result:unknown;
  if(command.op==='arm')armed=command.phase;
  else if(command.op==='fail-projection')failProjection=true;
  else if(command.op==='fail-sqlite'||command.op==='repair-sqlite'){
   const db=new DatabaseSync(join(directory!,sessionId!+'.events.sqlite'));
   try{db.exec(command.op==='fail-sqlite'?"CREATE TRIGGER eval_reject BEFORE INSERT ON thinking_events BEGIN SELECT RAISE(ABORT,'EVAL_SQLITE_WRITE_FAILED'); END;":'DROP TRIGGER eval_reject')}finally{db.close()}
  }
  else if(command.op==='health')result=store.health();
  else if(command.op==='write')await store.write(command.value!);
  else if(command.op==='snapshot')result=store.read(sessionId!,false);
  else if(command.op==='events')result=store.readEvents(sessionId!,command.after??0,1000)?.events;
  else throw Error('UNKNOWN_COMMAND');
  process.send?.({id:command.id,result});
 }catch(error){process.send?.({id:command.id,error:error instanceof Error?error.message:String(error)})}
});
process.send?.({event:'ready'});
