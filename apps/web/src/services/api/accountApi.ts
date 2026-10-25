import { getJson } from './client'

/** AI-point allowance of the signed-in author (pricing Phase 0). */
export type AccountUsage = {
  plan: 'free' | 'plus' | 'pro'
  month: UsageWindow
  day: UsageWindow
  features: { review: boolean }
  paused: boolean
}
export type UsageWindow = { limit: number; used: number; reserved: number; resetsAt: string }

function window(value: unknown): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
  const limit = n(v.limit), used = n(v.used), reserved = n(v.reserved)
  if (limit === null || used === null || reserved === null || typeof v.resetsAt !== 'string') return null
  return { limit, used, reserved, resetsAt: v.resetsAt }
}

/** Strict parse; anything unexpected hides the meter instead of guessing. */
export function parseAccount(value: unknown): AccountUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const month = window(v.month), day = window(v.day)
  const features = v.features as Record<string, unknown> | undefined
  if (!month || !day || (v.plan !== 'free' && v.plan !== 'plus' && v.plan !== 'pro') || typeof features?.review !== 'boolean' || typeof v.paused !== 'boolean') return null
  return { plan: v.plan, month, day, features: { review: features.review }, paused: v.paused }
}

export async function fetchAccount(): Promise<AccountUsage | null> {
  return parseAccount(await getJson('/v1/account'))
}

/** Points still usable now: the tighter of the monthly and daily windows. */
export function remaining(a: AccountUsage): number {
  const left = (w: UsageWindow) => Math.max(0, w.limit - w.used - w.reserved)
  return Math.min(left(a.month), left(a.day))
}
