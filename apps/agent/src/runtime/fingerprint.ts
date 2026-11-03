// Canonical JSON for request identity and tool deduplication, including nested objects.
export function canonicalJSON(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([,x]) => x !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,sort(x)])) : v;
  return JSON.stringify(sort(value));
}

export function modelIdentity(model: {provider: string; model: string; endpoint: string}): string {
  return JSON.stringify({provider: model.provider, model: model.model, endpoint: model.endpoint});
}
