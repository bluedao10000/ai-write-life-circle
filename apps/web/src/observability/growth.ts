// No SDK, persistence, network transport, identity, URL or prose in this interface.
// An operator must explicitly install a reviewed aggregate sink after consent.
export const growthEvents = [
  'studio_entry',
  'writing_started',
  'chapter_saved',
  'second_chapter_created',
  'first_publication',
  'book_view',
  'reading_started',
  'next_chapter',
] as const
export type GrowthEvent = (typeof growthEvents)[number]
export type GrowthSource =
  | 'direct_or_unknown'
  | 'google'
  | 'bing'
  | 'ai_referrer'
export type GrowthMetric = Readonly<{
  event: GrowthEvent
  source: GrowthSource
}>
let sink: ((metric: GrowthMetric) => void) | undefined
export function installGrowthSink(next?: (metric: GrowthMetric) => void) {
  sink = next
}
export function sourceBucket(referrer: string): GrowthSource {
  try {
    const host = new URL(referrer).hostname
    if (
      [
        'google.com',
        'www.google.com',
        'www.google.co.uk',
        'www.google.com.hk',
        'www.google.com.tw',
        'www.google.cn',
      ].includes(host)
    )
      return 'google'
    if (/^(www\.)?bing\.com$/.test(host)) return 'bing'
    if (
      [
        'chatgpt.com',
        'www.perplexity.ai',
        'perplexity.ai',
        'claude.ai',
      ].includes(host)
    )
      return 'ai_referrer'
  } catch {
    /* An absent referrer has no reliable attribution. */
  }
  return 'direct_or_unknown'
}
export function emitGrowth(
  event: GrowthEvent,
  source: GrowthSource = 'direct_or_unknown',
) {
  if (
    !growthEvents.includes(event) ||
    !['direct_or_unknown', 'google', 'bing', 'ai_referrer'].includes(source)
  )
    return
  try {
    sink?.(Object.freeze({ event, source }))
  } catch {
    /* Metrics never block writing or publishing. */
  }
}
