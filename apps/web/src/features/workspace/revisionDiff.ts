import { diffLines } from 'diff'

/** Bound both input and Myers edit work; full source remains readable separately. */
export function revisionDiff(before: string, after: string) {
  if (before.length + after.length > 300_000) return null
  const parts = diffLines(before, after, { timeout: 50, maxEditLength: 1500 })
  if (!parts || parts.length > 300) return null
  return parts.map((part, i) => ({
    kind: part.added ? (parts[i - 1]?.removed ? '修改后' : '新增') : part.removed ? (parts[i + 1]?.added ? '修改前' : '删除') : '未变',
    text: part.value.length > 8000 ? part.value.slice(0, 8000) + '\n…本段仅展示前 8000 字，完整内容见正文栏。' : part.value,
  }))
}
