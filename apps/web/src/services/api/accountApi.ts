import { getJson, postJson } from './client'

export type PlanId = 'free' | 'plus' | 'pro'

/** Plan, AI points and plan limits of the signed-in author (GET /v1/account). */
export type AccountUsage = {
  plan: PlanId
  /** Set for a granted plan; empty for the default plan. */
  interval?: 'month' | 'year'
  source?: string
  expiresAt?: string
  month: UsageWindow
  day: UsageWindow
  features: { review: boolean; topups: boolean }
  paused: boolean
  topups: Topups
  limits: PlanLimits
  byKind: Record<string, number>
  recent: UsageEntry[]
  counts?: { books: number; importsThisMonth: number }
  catalog: Catalog
}
export type UsageWindow = { limit: number; used: number; reserved: number; resetsAt: string }
export type Topups = { left: number; frozen: boolean; usedThisMonth: number; items: { points: number; left: number; expiresAt: string }[] }
export type PlanLimits = { books: number; sessions: number; importsPerMonth: number; priority: boolean }
export type UsageEntry = { kind: string; points: number; at: string }
export type CatalogPlan = PlanLimits & { id: PlanId; monthly: number; daily: number; review: boolean; topups: boolean; monthlyUsdCents: number; yearlyUsdCents: number }
export type Catalog = { plans: CatalogPlan[]; packs: { points: number; usdCents: number }[] }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null)
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
const isPlan = (x: unknown): x is PlanId => x === 'free' || x === 'plus' || x === 'pro'

function window(value: unknown): UsageWindow | null {
  const v = obj(value)
  if (!v) return null
  const limit = num(v.limit), used = num(v.used), reserved = num(v.reserved)
  if (limit === null || used === null || reserved === null || typeof v.resetsAt !== 'string') return null
  return { limit, used, reserved, resetsAt: v.resetsAt }
}

function limits(value: unknown): PlanLimits | null {
  const v = obj(value)
  const books = num(v?.books), sessions = num(v?.sessions), imports = num(v?.importsPerMonth)
  if (!v || books === null || sessions === null || imports === null || typeof v.priority !== 'boolean') return null
  return { books, sessions, importsPerMonth: imports, priority: v.priority }
}

function topups(value: unknown): Topups {
  const v = obj(value)
  const items = Array.isArray(v?.items)
    ? v.items.flatMap((raw) => {
      const t = obj(raw)
      const points = num(t?.points), left = num(t?.left)
      return points !== null && left !== null && typeof t?.expiresAt === 'string' ? [{ points, left, expiresAt: t.expiresAt }] : []
    })
    : []
  return { left: num(v?.left) ?? 0, frozen: v?.frozen === true, usedThisMonth: num(v?.usedThisMonth) ?? 0, items }
}

function catalog(value: unknown): Catalog {
  const v = obj(value)
  const plans = Array.isArray(v?.plans)
    ? v.plans.flatMap((raw) => {
      const p = obj(raw)
      const l = limits(p)
      const monthly = num(p?.monthly), daily = num(p?.daily), mc = num(p?.monthlyUsdCents), yc = num(p?.yearlyUsdCents)
      if (!p || !l || !isPlan(p.id) || monthly === null || daily === null || mc === null || yc === null || typeof p.review !== 'boolean' || typeof p.topups !== 'boolean') return []
      return [{ ...l, id: p.id, monthly, daily, review: p.review, topups: p.topups, monthlyUsdCents: mc, yearlyUsdCents: yc }]
    })
    : []
  const packs = Array.isArray(v?.packs)
    ? v.packs.flatMap((raw) => {
      const p = obj(raw)
      const points = num(p?.points), usdCents = num(p?.usdCents)
      return points !== null && usdCents !== null ? [{ points, usdCents }] : []
    })
    : []
  return { plans, packs }
}

/**
 * Strict on the fields the meter needs; anything unexpected there hides the
 * meter instead of guessing. Detail fields (top-ups, limits, history) fall
 * back to empty values so an older API still shows the meter.
 */
export function parseAccount(value: unknown): AccountUsage | null {
  const v = obj(value)
  if (!v) return null
  const month = window(v.month), day = window(v.day)
  const features = obj(v.features)
  if (!month || !day || !isPlan(v.plan) || typeof features?.review !== 'boolean' || typeof v.paused !== 'boolean') return null
  const counts = obj(v.counts)
  const books = num(counts?.books), imports = num(counts?.importsThisMonth)
  const byKind: Record<string, number> = {}
  for (const [k, n] of Object.entries(obj(v.byKind) ?? {})) if (num(n) !== null) byKind[k] = n as number
  const recent = Array.isArray(v.recent)
    ? v.recent.flatMap((raw) => {
      const e = obj(raw)
      const points = num(e?.points)
      return e && typeof e.kind === 'string' && typeof e.at === 'string' && points !== null ? [{ kind: e.kind, points, at: e.at }] : []
    })
    : []
  return {
    plan: v.plan,
    interval: v.interval === 'month' || v.interval === 'year' ? v.interval : undefined,
    source: typeof v.source === 'string' && v.source ? v.source : undefined,
    expiresAt: typeof v.expiresAt === 'string' && v.expiresAt ? v.expiresAt : undefined,
    month,
    day,
    features: { review: features.review, topups: features.topups === true },
    paused: v.paused,
    topups: topups(v.topups),
    limits: limits(v.limits) ?? { books: 0, sessions: 0, importsPerMonth: 0, priority: false },
    byKind,
    recent,
    counts: books !== null && imports !== null ? { books, importsThisMonth: imports } : undefined,
    catalog: catalog(v.catalog),
  }
}

export async function fetchAccount(): Promise<AccountUsage | null> {
  return parseAccount(await getJson('/v1/account'))
}

/** Applies a redeem code; throws ApiProblemError with the server's message. */
export async function redeemCode(code: string): Promise<AccountUsage | null> {
  return parseAccount(await postJson('/v1/account/redeem', { code: code.trim() }, crypto.randomUUID()))
}

/** Usable top-up points (0 while frozen on Free). */
export function usableTopups(a: AccountUsage): number {
  return a.topups.frozen ? 0 : a.topups.left
}

/** Points usable this month: allowance left plus usable top-ups, minus open holds. */
export function monthLeft(a: AccountUsage): number {
  return Math.max(0, Math.max(0, a.month.limit - a.month.used) + usableTopups(a) - a.month.reserved)
}

export function dayLeft(a: AccountUsage): number {
  return Math.max(0, a.day.limit - a.day.used - a.day.reserved)
}

/** Points still usable now: the tighter of the monthly and daily windows. */
export function remaining(a: AccountUsage): number {
  return Math.min(monthLeft(a), dayLeft(a))
}
