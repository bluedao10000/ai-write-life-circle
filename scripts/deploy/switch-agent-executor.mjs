// Run manually as the Go state owner; never invoked by CI or automatic deployment.
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2),read=name=>args[args.indexOf(name)+1];
const kind=read('--kind'),owner=read('--owner'),state=read('--state'),control=read('--control');
if(!args.includes('--confirm-executor-switch')||!['review','knowledge'].includes(kind)||!['go','pi','disabled'].includes(owner)||!state?.startsWith('/')||!control?.startsWith('/')){
 console.error('Required: --confirm-executor-switch --kind review|knowledge --owner go|pi|disabled --state /absolute/state --control /absolute/writer-agent-control');process.exit(2);
}
function run(command,argv){const result=spawnSync(command,argv,{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1)}
if(owner==='go'){
 const compatible=spawnSync('/opt/writer-agent/current/writer-agent-worker',['--task-protocol'],{encoding:'utf8'});
 if(compatible.status!==0||compatible.stdout.trim()!=='agent-tasks-v1')throw Error('Compatible Go fallback binary required before switching');
}
// Starting a service grants no task ownership. Validate the target before draining.
if(owner==='pi'){
 run('/opt/writer-agent-pi/node/bin/node',[new URL('./verify-pi-release.mjs',import.meta.url).pathname,'/opt/writer-agent-pi/current','--worker']);
 run('systemctl',['is-active','--quiet','writer-agent-pi-worker.service']);
 run('runuser',['-u','writer-agent-pi-worker','--','/bin/sh','-c','set -a; . /etc/writer-agent-pi-worker/worker.env; exec /opt/writer-agent-pi/node/bin/node /opt/writer-agent-pi/current/dist/worker/main.js --healthcheck']);
}
run(control,['--state',state,'--kind',kind,'--owner',owner,'--wait','200s']);
// The durable epoch is fenced before the fallback process starts.
if(owner==='go')run('systemctl',['start','writer-agent-worker.service']);
run(control,['--state',state]);
console.log('Ownership committed. Verify per-kind readiness and an isolated synthetic task before disabling any fallback service.');
