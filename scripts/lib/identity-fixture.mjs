// Test-only per-user identity (SEC-001): an Ed25519 key pair for the Go API
// and the login Worker, plus assertions for fixtures that call Go directly.
import { generateKeyPairSync, sign } from 'node:crypto'

export const IDENTITY_HEADER = 'x-writer-agent-identity'

/**
 * `user` should match the Better Auth user a browser test signs in as, so
 * direct fixture calls and Worker-forwarded calls act as the same author.
 * The fixture email is also the legacy owner email, so it inherits the
 * configured WRITER_AGENT_AUTHOR_ID exactly as production does.
 */
export function identityFixture(user = { id: 'fixture-user', email: 'author@example.com' }) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicB64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  const privateB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
  const assertion = (method, path, who = user) => {
    const iat = Math.floor(Date.now() / 1000)
    const head = b64({ alg: 'EdDSA', typ: 'JWT' })
    const body = b64({ iss: 'story2u-worker', aud: 'writer-agent-api', sub: who.id, email: who.email, email_verified: true, iat, exp: iat + 60, mth: method, pth: path })
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
  }
  return {
    user,
    publicKey: publicB64,
    privateKey: privateB64,
    /** Go API environment. */
    goEnv: { WRITER_AGENT_IDENTITY_PUBLIC_KEY: publicB64, WRITER_AGENT_LEGACY_OWNER_EMAIL: user.email },
    /** Headers for a direct Go call; `url` may be a path or absolute URL. */
    headers(method, url, who = user) {
      const path = new URL(url, 'http://fixture.invalid').pathname
      return { [IDENTITY_HEADER]: assertion(method, path, who) }
    },
  }
}
