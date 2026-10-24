import { spawn } from 'node:child_process'

const projectId = process.env.VITE_WRITER_AGENT_PROJECT_ID?.trim() || process.env.WRITER_AGENT_PROJECT_ID?.trim() || 'local'
const apiPort = process.env.WRITER_AGENT_API_PORT || '8787'
const apiTarget = `http://127.0.0.1:${apiPort}`
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const withAgent=process.argv.includes('--agent')
const agent=withAgent?spawn(pnpm,['dev:agent'],{stdio:'inherit',detached:process.platform!=='win32',env:process.env}):null
const api = spawn(pnpm, ['dev:api:go'], {
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: { ...process.env, NODE_ENV: 'development', WRITER_AGENT_PROJECT_ID: projectId, WRITER_AGENT_API_PORT: apiPort },
})
const web = spawn(pnpm, ['--filter', '@writer-agent/web', 'dev'], {
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    VITE_WRITER_AGENT_MODE: 'api',
    VITE_WRITER_AGENT_PROJECT_ID: projectId,
    WRITER_AGENT_API_TARGET: apiTarget,
  },
})

let stopping = false
function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  for (const child of [api, web, agent].filter(Boolean)) {
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
api.once('exit', (code) => {
  if (!stopping) {
    process.stderr.write(`API 服务退出 (${code ?? 'signal'})；正在关闭 Web 服务。\n`)
    stop()
    process.exitCode = code ?? 1
  }
})
web.once('exit', (code) => {
  if (!stopping) {
    process.stderr.write(`Web 服务退出 (${code ?? 'signal'})；正在关闭 API 服务。\n`)
    stop()
    process.exitCode = code ?? 1
  }
})

agent?.once("exit",code=>{if(!stopping)process.stderr.write(`Thinking Agent exited (${code}); writing API and Web remain available.\n`)})
