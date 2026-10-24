import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const stateDirectory = await mkdtemp(join(tmpdir(), 'writer-agent-api-e2e-'))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(pnpm, ['exec', 'playwright', 'test', '--config', 'playwright.api.config.ts'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: { ...process.env, WRITER_AGENT_E2E_STATE_DIR: stateDirectory },
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal))
}

const exitCode = await new Promise((resolveExit) => {
  child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    resolveExit(1)
  })
  child.once('exit', (code) => resolveExit(code ?? 1))
})
await rm(stateDirectory, { recursive: true, force: true })
process.exitCode = exitCode
