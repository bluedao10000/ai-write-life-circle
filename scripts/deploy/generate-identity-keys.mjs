#!/usr/bin/env node
// Generates the Ed25519 key pair for per-user identity (SEC-001).
//
//   node scripts/deploy/generate-identity-keys.mjs <output-dir>
//
// Writes, with mode 0600:
//   <dir>/identity-private.pkcs8.b64  → GitHub secret WRITER_AGENT_IDENTITY_PRIVATE_KEY (login Worker)
//   <dir>/identity-public.b64         → WRITER_AGENT_IDENTITY_PUBLIC_KEY in /etc/writer-agent/api.env (Go API)
// Only the public key is printed. Delete the private file after storing the secret.
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: generate-identity-keys.mjs <output-dir>')
  process.exit(1)
}
const out = resolve(dir)
mkdirSync(out, { recursive: true, mode: 0o700 })
const privatePath = join(out, 'identity-private.pkcs8.b64')
const publicPath = join(out, 'identity-public.b64')
if (existsSync(privatePath) || existsSync(publicPath)) {
  console.error('Refusing to overwrite existing identity keys in ' + out)
  process.exit(1)
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
// The raw public key is the last 32 bytes of the SPKI encoding.
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
writeFileSync(privatePath, pkcs8.toString('base64') + '\n', { mode: 0o600, flag: 'wx' })
writeFileSync(publicPath, raw.toString('base64') + '\n', { mode: 0o600, flag: 'wx' })
console.log('WRITER_AGENT_IDENTITY_PUBLIC_KEY=' + raw.toString('base64'))
console.log('Private key written to ' + privatePath + ' (store as the GitHub secret WRITER_AGENT_IDENTITY_PRIVATE_KEY, then delete the file).')
