// Canonical JSON for request identity and tool deduplication, including nested objects.
export function canonicalJSON(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([,x]) => x !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,sort(x)])) : v;
  return JSON.stringify(sort(value));
}
