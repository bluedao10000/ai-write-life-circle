import { describe, expect, it } from 'vitest'
import { parseAccount, remaining } from '../services/api/accountApi'

const w = (limit: number, used: number, reserved = 0) => ({ limit, used, reserved, resetsAt: '2026-11-01T00:00:00Z' })

describe('AI point account', () => {
  it('parses strictly and reports the tighter remaining window', () => {
    const a = parseAccount({ plan: 'free', month: w(1500, 1400), day: w(300, 20, 50), features: { review: false }, paused: false })
    expect(a?.plan).toBe('free')
    expect(remaining(a!)).toBe(100)
    expect(remaining(parseAccount({ plan: 'pro', month: w(18000, 100), day: w(4000, 3990, 50), features: { review: true }, paused: false })!)).toBe(0)
  })
  it('counts usable top-ups toward the month but never the day', () => {
    const base = { plan: 'plus', interval: 'year', source: 'code', expiresAt: '2027-10-25T00:00:00Z', month: w(6000, 6000, 100), day: w(1500, 200), features: { review: true, topups: true }, paused: false }
    const a = parseAccount({ ...base, topups: { left: 3000, frozen: false, usedThisMonth: 400, items: [{ points: 3000, left: 3000, expiresAt: '2027-10-25T00:00:00Z' }] } })!
    expect(remaining(a)).toBe(1300) // daily window is tighter than 3000 − 100
    expect(a.interval).toBe('year')
    expect(a.topups.items).toHaveLength(1)
    const frozen = parseAccount({ ...base, plan: 'free', topups: { left: 3000, frozen: true, usedThisMonth: 0, items: [] } })!
    expect(remaining(frozen)).toBe(0)
  })
  it('parses the plan catalog, limits and history, and tolerates an older API', () => {
    const a = parseAccount({
      plan: 'free', month: w(1500, 10), day: w(300, 10), features: { review: false, topups: false }, paused: false,
      limits: { books: 3, sessions: 1, importsPerMonth: 2, priority: false },
      counts: { books: 2, importsThisMonth: 1 },
      byKind: { thinking: 10, bogus: 'x' },
      recent: [{ kind: 'thinking', points: 10, at: '2026-10-25T12:00:00Z' }, { kind: 1 }],
      catalog: { plans: [{ id: 'pro', monthly: 18000, daily: 4000, review: true, topups: true, books: 300, sessions: 4, importsPerMonth: 0, priority: true, monthlyUsdCents: 1299, yearlyUsdCents: 12900 }, { id: 'gold' }], packs: [{ points: 3000, usdCents: 299 }] },
    })!
    expect(a.limits.books).toBe(3)
    expect(a.counts).toEqual({ books: 2, importsThisMonth: 1 })
    expect(a.byKind).toEqual({ thinking: 10 })
    expect(a.recent).toHaveLength(1)
    expect(a.catalog.plans.map((p) => p.id)).toEqual(['pro'])
    const old = parseAccount({ plan: 'free', month: w(1500, 0), day: w(300, 0), features: { review: false }, paused: false })!
    expect(old.catalog.plans).toEqual([])
    expect(old.topups.left).toBe(0)
  })
  it('hides the meter on unexpected payloads', () => {
    for (const bad of [null, {}, { plan: 'gold', month: w(1, 0), day: w(1, 0), features: { review: true }, paused: false }, { plan: 'free', month: { limit: -1, used: 0, reserved: 0, resetsAt: 'x' }, day: w(1, 0), features: { review: true }, paused: false }])
      expect(parseAccount(bad)).toBeNull()
  })
})
