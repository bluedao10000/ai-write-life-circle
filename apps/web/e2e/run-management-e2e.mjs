import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const root = await mkdtemp(join(tmpdir(), 'story2u-managed-e2e-'))
await mkdir(join(root, 'harness'))
try {
  const child = spawn('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.management.config.ts'], { stdio: 'inherit', env: { ...process.env, WRITER_AGENT_MANAGEMENT_FIXTURE: root, WRITER_AGENT_LLM_API_KEY: '', WRITER_AGENT_LLM_BASE_URL: '', WRITER_AGENT_LLM_MODEL: '' } })
  for(const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
} finally { await rm(root, { recursive: true, force: true }) }
