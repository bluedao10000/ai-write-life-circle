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
  it('hides the meter on unexpected payloads', () => {
    for (const bad of [null, {}, { plan: 'gold', month: w(1, 0), day: w(1, 0), features: { review: true }, paused: false }, { plan: 'free', month: { limit: -1, used: 0, reserved: 0, resetsAt: 'x' }, day: w(1, 0), features: { review: true }, paused: false }])
      expect(parseAccount(bad)).toBeNull()
  })
})
