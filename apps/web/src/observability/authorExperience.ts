/** Opt-in aggregate metrics only. Never accept identity, URLs, prose or quotes. */
export type AuthorMetric =
  | Readonly<{ event: 'time_to_writing'; bucket: 'under_5s' | '5_to_15s' | '15_to_60s' | 'over_60s' }>
  | Readonly<{ event: 'revision_recovery'; bucket: 'attempt' | 'success' | 'failure' }>
  | Readonly<{ event: 'free_review'; bucket: 'started' | 'completed' }>
  | Readonly<{ event: 'review_feedback'; bucket: 'useful' | 'other' }>
let sink: ((metric: AuthorMetric) => void) | undefined
export function installAuthorMetricSink(next?: (metric: AuthorMetric) => void) { sink = next }
const allowed = {
  time_to_writing: ['under_5s','5_to_15s','15_to_60s','over_60s'],
  revision_recovery: ['attempt','success','failure'], free_review: ['started','completed'], review_feedback: ['useful','other'],
}
export function emitAuthorMetric(metric: AuthorMetric) {
  if (!Object.prototype.hasOwnProperty.call(allowed, metric.event) || !(allowed[metric.event] as readonly string[]).includes(metric.bucket)) return
  // Rebuild the object to discard unexpected runtime keys.
  try { sink?.(Object.freeze({ event: metric.event, bucket: metric.bucket } as AuthorMetric)) } catch { /* Writing must never depend on metrics. */ }
}
export function recordTimeToWriting(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return
  emitAuthorMetric({ event:'time_to_writing', bucket:ms<5000?'under_5s':ms<15000?'5_to_15s':ms<60000?'15_to_60s':'over_60s' })
}
