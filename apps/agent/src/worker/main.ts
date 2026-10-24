import {loadWorkerConfig} from './config.js';
import {TaskClient} from './task-client.js';
import {Scheduler} from './scheduler.js';
async function main(){
 if(process.argv.includes('--version')){console.log('agent-tasks-v1');return}
 const config=loadWorkerConfig();
 if(process.argv.includes('--check-config')){await new TaskClient(config,'preflight').check();console.log(JSON.stringify({protocol:'agent-tasks-v1',version:config.version,model:config.model.Model}));return}
 if(process.argv.includes('--healthcheck')){const client=new TaskClient(config,'healthcheck');await client.check();const status=await client.request('status');if(status.online!==true||status.ready!==true||status.configFingerprint!==JSON.stringify(config.model))throw Error('WORKER_NOT_READY');return}
 const abort=new AbortController();process.once('SIGTERM',()=>abort.abort());process.once('SIGINT',()=>abort.abort());await new Scheduler(config).run(abort.signal);
}
main().catch(()=>{console.error(JSON.stringify({event:'worker_failed',code:'WORKER_START_FAILED'}));process.exitCode=1});
