// Test-only Pi Worker wiring for browser fixtures. The caller owns the Go API.
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'

async function freePort() {
  const server=createServer()
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=server.address().port
  await new Promise(resolve=>server.close(resolve))
  return port
}

export async function preparePiWorker(fixture,{apiPort,project='review-fixture',executionEnv={}}) {
  const taskPort=await freePort()
  const tokenFile=join(fixture.directory,'task-token')
  await writeFile(tokenFile,crypto.randomUUID().replaceAll('-',''),{mode:0o600})
  const taskEnv={
    WRITER_AGENT_TASK_SERVICE_TOKEN_FILE:tokenFile,
    WRITER_AGENT_TASK_INTERNAL_HOST:'127.0.0.1',
    WRITER_AGENT_TASK_INTERNAL_PORT:String(taskPort),
  }
  const apiEnv={
    ...taskEnv,
    WRITER_AGENT_ENV:'test',
    WRITER_AGENT_PROJECT_ID:project,
    WRITER_AGENT_API_PORT:String(apiPort),
    WRITER_AGENT_HARNESS_ROOT:fixture.harness,
    WRITER_AGENT_STATE_DIR:fixture.state,
    WRITER_AGENT_LLM_PROVIDER:'openai-compatible',
    WRITER_AGENT_LLM_BASE_URL:`${fixture.origin}/v1`,
    WRITER_AGENT_LLM_MODEL:'deterministic-test-only',
    WRITER_AGENT_LLM_API_KEY:'',
    WRITER_AGENT_LLM_RESPONSE_FORMAT:'none',
    WRITER_AGENT_LLM_TOKEN_PARAMETER:'max_completion_tokens',
    WRITER_AGENT_LLM_TIMEOUT_SECONDS:'2',
    ...executionEnv,
  }
  const workerEnv={
    ...apiEnv,
    WRITER_AGENT_TASK_ORIGIN:`http://127.0.0.1:${taskPort}`,
    WRITER_AGENT_PI_WORKER_FIXTURE:'1',
    WRITER_AGENT_PI_WORKER_LLM_API_KEY:'synthetic-fixture-only',
  }
  let worker
  return {
    apiEnv,
    async startWorker() {
      worker=spawn(process.execPath,[new URL('../../apps/agent/dist/worker/main.js',import.meta.url).pathname],{
        env:{...process.env,...workerEnv},
        stdio:['ignore','pipe','pipe'],
      })
      let output=''
      try {
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('Pi Worker startup timeout: '+output)),15000)
          worker.stdout.on('data',chunk=>{output+=chunk;if(output.includes('worker_started')){clearTimeout(timer);resolve()}})
          worker.stderr.on('data',chunk=>{output+=chunk})
          worker.once('error',error=>{clearTimeout(timer);reject(error)})
          worker.once('exit',code=>{clearTimeout(timer);reject(Error(`Pi Worker exited ${code}: ${output}`))})
        })
      } catch(error) {
        worker.kill('SIGTERM')
        throw error
      }
    },
    async stopWorker() {
      if(!worker||worker.exitCode!==null||worker.signalCode!==null)return
      await new Promise(resolve=>{
        worker.once('exit',resolve)
        worker.kill('SIGTERM')
        setTimeout(()=>worker.kill('SIGKILL'),6000).unref()
      })
    },
  }
}
