// Browser storage partition per signed-in account (SEC-002).
//
// The login Worker returns an opaque `scope` derived from the immutable user
// ID. Recovery drafts and selected-work state are keyed by it, so switching
// Google accounts in one browser never surfaces another account's prose.
// Without sign-in (local/demo/API e2e) the scope stays `local` and keys keep
// their historical names.

const LOCAL = 'local'
let scope = LOCAL

export function setStorageScope(value: string | undefined): void {
  scope = value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : LOCAL
}

export function storageScope(): string {
  return scope
}

/** Key for per-account session state; unchanged when no account is signed in. */
export function scopedKey(base: string): string {
  return scope === LOCAL ? base : `${base}@${scope}`
}

/**
 * Read per-account session state. A value stored under the historical
 * unscoped key (before accounts were separated) is adopted once and removed;
 * these values are IDs that the API still authorizes per account.
 */
export function readScopedSession(base: string): string | null {
  try {
    const key = scopedKey(base)
    const value = sessionStorage.getItem(key)
    if (value !== null || key === base) return value
    const legacy = sessionStorage.getItem(base)
    if (legacy !== null) {
      sessionStorage.removeItem(base)
      sessionStorage.setItem(key, legacy)
    }
    return legacy
  } catch {
    return null
  }
}

export function writeScopedSession(base: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(scopedKey(base))
    else sessionStorage.setItem(scopedKey(base), value)
  } catch {
    // Optional browser state.
  }
}

/** Forget this account's session state on sign-out. */
export function clearScopedSession(): void {
  try {
    const suffix = scope === LOCAL ? null : `@${scope}`
    const keys: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (!key) continue
      if ((suffix && key.endsWith(suffix)) || key.startsWith('writer-agent:') || key.startsWith('thinking-v1:')) keys.push(key)
    }
    for (const key of keys) sessionStorage.removeItem(key)
  } catch {
    // Optional browser state.
  }
}
