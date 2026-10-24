import { readFile, writeFile } from 'node:fs/promises'

const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !token) throw Error('Cloudflare deployment credentials are required.')
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database`
async function api(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  if (!response.ok) throw Error(`Cloudflare D1 request failed (${response.status}); token needs D1 read/write permission.`)
  const result = await response.json()
  if (!result.success) throw Error('Cloudflare D1 operation did not succeed.')
  return result.result
}
const name = 'story2u-auth'
let database
for (let page = 1; page <= 100; page++) {
  const entries = await api(`${endpoint}?per_page=100&page=${page}`)
  database = entries.find(item => item.name === name)
  if (database || entries.length < 100) break
}
if (!database) database = await api(endpoint, { method: 'POST', body: JSON.stringify({ name }) })
if (!/^[a-f0-9-]{36}$/.test(database.uuid)) throw Error('Invalid D1 database identifier.')
let base = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8')
for (const key of ['GOOGLE_SITE_VERIFICATION', 'BING_SITE_VERIFICATION']) {
  const value = process.env[key]?.trim()
  if (!value) continue
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw Error('Invalid site verification value: ' + key)
  base = base.replace('[vars]\n', '[vars]\n' + key + ' = ' + JSON.stringify(value) + '\n')
}
await writeFile(new URL('../wrangler.auth.generated.toml', import.meta.url), `${base}\n[[d1_databases]]\nbinding = "AUTH_DB"\ndatabase_name = "${name}"\ndatabase_id = "${database.uuid}"\nmigrations_dir = "migrations"\n`)
console.log('Auth D1 binding prepared. Existing database is retained; no tables are dropped.')
