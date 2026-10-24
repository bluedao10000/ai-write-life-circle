import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const root = await mkdtemp(join(tmpdir(), 'story2u-public-e2e-')),
  harness = join(root, 'harness'),
  state = join(root, 'state')
try {
  await mkdir(join(harness, 'manuscript'), { recursive: true })
  await mkdir(join(harness, 'notes'), { recursive: true })
  for (let i = 1; i <= 3; i++)
    await writeFile(
      join(harness, 'manuscript', `CH-00${i}.md`),
      `# 第${i}章 合成故事\nID: CH-00${i}\nvolumeId: ${i === 3 ? 'V2' : 'V1'}\norder: ${i === 3 ? 1 : i}\n\n${Array.from({ length: 90 }, (_, n) => `第${i}章第${n + 1}段。河流绕过安静的村庄，窗边的人打开一封远方来信。这是隔离测试中的合成正文，不是真实作品。`).join('\n\n')}\n`,
    )
  await writeFile(
    join(harness, 'notes', 'private.md'),
    '# Private\nID: NOTE-001\n\nNEVER_PUBLIC_SITE_NOTE',
  )
  const child = spawn(
    'pnpm',
    ['exec', 'playwright', 'test', '--config', 'playwright.public.config.ts'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        WRITER_AGENT_PUBLIC_FIXTURE_ROOT: harness,
        WRITER_AGENT_PUBLIC_FIXTURE_STATE: state,
      },
    },
  )
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => child.kill(signal))
  process.exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(1))
    child.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  await rm(root, { recursive: true, force: true })
}
