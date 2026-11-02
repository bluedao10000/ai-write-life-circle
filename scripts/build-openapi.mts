// Single entry point for all OpenAPI contract generation.
// Runs every domain generator under scripts/openapi/ sequentially; each
// generator supports --check (verify drift, write nothing) like before.
//
// Usage:
//   pnpm exec tsx scripts/build-openapi.mts            regenerate all contracts
//   pnpm exec tsx scripts/build-openapi.mts --check    fail if any contract is stale
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('./openapi/', import.meta.url))
const generators = readdirSync(dir)
  .filter((name) => name.endsWith('.mts') || name.endsWith('.mjs'))
  .sort()

const check = process.argv.includes('--check')
const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))

for (const name of generators) {
  const isTs = name.endsWith('.mts')
  const cmd = isTs ? tsx : process.execPath
  const args = [dir + name, ...(check ? ['--check'] : [])]
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`openapi generator failed: ${name}`)
    process.exit(result.status ?? 1)
  }
}
console.log(`${generators.length} OpenAPI contracts ${check ? 'verified' : 'generated'}.`)
