// Add this predicate to PR #11's existing authenticated API allowlist. This file
// authenticates nobody: its caller must first obtain the existing author session.
export function publicationRoute(
  path: string,
  method: string,
  projectId: string,
): boolean {
  if (path.includes('%') || path.includes('\\')) return false
  const prefix = `/v1/studio/books/${encodeURIComponent(projectId)}/publication`
  if (method === 'GET') return path === prefix || path === prefix + '/versions'
  return (
    method === 'POST' &&
    ['preview', 'versions', 'unlist', 'relist'].some(
      (op) => path === prefix + '/' + op,
    )
  )
}
