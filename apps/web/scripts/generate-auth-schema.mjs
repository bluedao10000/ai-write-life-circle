import { DatabaseSync } from 'node:sqlite'
import { getMigrations } from 'better-auth/db/migration'
import { writeFile, readFile } from 'node:fs/promises'
import { createAuth } from '../worker/auth.ts'

const db = new DatabaseSync(':memory:')
const auth = createAuth({ AUTH_DB: db, BETTER_AUTH_URL: 'https://writer.example', BETTER_AUTH_SECRET: 'synthetic-schema-generation-secret-only', GOOGLE_CLIENT_ID: 'fixture', GOOGLE_CLIENT_SECRET: 'fixture' })
const migration = await getMigrations(auth.options)
const sql = '-- Generated from Better Auth 1.7.10; pnpm --filter @writer-agent/web auth:schema\n' + await migration.compileMigrations() + '\n'
const target = new URL('../migrations/0001_better_auth.sql', import.meta.url)
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== sql) throw Error('Auth schema differs; regenerate and review the migration.')
} else await writeFile(target, sql)
db.close()
