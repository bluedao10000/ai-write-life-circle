// Per-request user assertion for the Go API (SEC-001).
//
// The service Bearer token proves a request came through this Worker; this
// Ed25519-signed assertion names the signed-in Better Auth user and binds the
// exact method and path. Go verifies it with the matching public key and makes
// each user a separate author. Browser-supplied identity headers never reach Go.

export const IDENTITY_HEADER = 'x-writer-agent-identity'
export const IDENTITY_MODE_HEADER = 'x-writer-agent-identity-mode'
export const IDENTITY_MODE = 'per-user-v1'
const LIFETIME_SECONDS = 60

export type SignedInUser = { id: string; email: string; emailVerified: boolean }

const encoder = new TextEncoder()
const keys = new Map<string, Promise<CryptoKey>>()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** The private key is a base64 PKCS#8 Ed25519 key (see scripts/deploy/generate-identity-keys.mjs). */
export function identityConfigured(privateKey: string | undefined): boolean {
  if (!privateKey?.trim()) return false
  try {
    return decodeBase64(privateKey).byteLength === 48
  } catch {
    return false
  }
}

function signingKey(privateKey: string): Promise<CryptoKey> {
  let key = keys.get(privateKey)
  if (!key) {
    key = crypto.subtle.importKey('pkcs8', decodeBase64(privateKey), { name: 'Ed25519' }, false, ['sign'])
    keys.set(privateKey, key)
    key.catch(() => keys.delete(privateKey))
  }
  return key
}

export async function signIdentity(privateKey: string, user: SignedInUser, method: string, path: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000)
  const head = base64url(encoder.encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })))
  const body = base64url(encoder.encode(JSON.stringify({
    iss: 'story2u-worker', aud: 'writer-agent-api', sub: user.id, email: user.email,
    email_verified: user.emailVerified === true, iat, exp: iat + LIFETIME_SECONDS, mth: method, pth: path,
  })))
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, await signingKey(privateKey), encoder.encode(`${head}.${body}`))
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`
}

/**
 * Opaque per-user scope for browser storage keys. It is derived from the
 * immutable user ID, so drafts never mix between accounts on one browser.
 */
export async function storageScope(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode('writer-agent-storage-v1:' + userId))
  return base64url(new Uint8Array(digest).slice(0, 16))
}

/** Go must advertise per-user identity; anything else could merge users onto one author. */
export function perUserAPI(response: Response): boolean {
  return response.headers.get(IDENTITY_MODE_HEADER) === IDENTITY_MODE
}
