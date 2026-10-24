import type { CreativeContent, CreativeProposal } from '@writer-agent/contracts'
import { ApiProblemError } from '../../services/writerAgent'

export { creativeKindLabels as kindLabels, creativeStanceLabels as stanceLabels } from '@writer-agent/contracts'

export const operationLabels: Record<CreativeProposal['operation'], string> = {
  CREATE: '新增设定',
  UPDATE: '补充设定',
  LINK: '建立关联',
  SUPERSEDE: '替换旧设定',
}

export const proposalStatusLabels: Record<CreativeProposal['status'], string> = {
  proposed: '待审核',
  accepted: '已接受',
  rejected: '已拒绝',
  superseded: '已被后续讨论修订',
  expired: '已失效',
}

export const assetStatusLabels = {
  draft: '草稿',
  accepted: '已确认',
  superseded: '已被替代',
  archived: '已归档',
} as const

export const turnStatusLabels: Record<string, string> = {
  awaiting: '等待回复完成',
  queued: '正在整理',
  organized: '已整理',
  no_change: '无新设定',
  skipped: '未整理（回复未完成）',
  cancelled: '已取消',
  failed: '整理失败',
  expired: '已超时',
}

const codeMessages: Record<string, string> = {
  PROPOSAL_STALE: '这条设定在别处被修改过。请查看当前版本，编辑后再接受。',
  ALTERNATIVE_CONFLICT: '同一组互斥方案中已有一个被接受。如要改选，请先归档已接受的方案。',
  DUPLICATE_ASSET: '已经存在同名设定。请修改名称，或到已有设定中补充。',
  PROPOSAL_NOT_PENDING: '这条候选已被处理，或已被后续讨论修订。',
  ASSET_VERSION_CONFLICT: '设定已被修改，请刷新后再试。',
  LINK_TARGET_PENDING: '请先接受被关联的新设定。',
  CREATIVE_CONSENT_REQUIRED: '请先启用灵感整理并确认模型范围。',
  CREATIVE_RATE_LIMIT: '操作太频繁，请稍后再试。',
  DIVERGENCE_SUPERSEDED: '已有更新的核对结果。',
}

export function creativeError(e: unknown) {
  if (e instanceof ApiProblemError && codeMessages[e.code]) return codeMessages[e.code]
  return e instanceof Error ? e.message : '操作未完成，请稍后重试。'
}

export type FieldChange = { key: string; before?: string; after?: string }

/** Field-level diff between the current asset and the content a proposal would produce. */
export function diffContent(current: CreativeContent | undefined, next: CreativeContent | undefined): FieldChange[] {
  const out: FieldChange[] = []
  const before = new Map((current?.fields ?? []).map((f) => [f.key, f.value]))
  const after = new Map((next?.fields ?? []).map((f) => [f.key, f.value]))
  if ((current?.name ?? '') !== (next?.name ?? '') && next) out.push({ key: '名称', before: current?.name, after: next.name })
  if ((current?.summary ?? '') !== (next?.summary ?? '')) out.push({ key: '概述', before: current?.summary || undefined, after: next?.summary || undefined })
  for (const [key, value] of after) if (before.get(key) !== value) out.push({ key, before: before.get(key), after: value })
  for (const [key, value] of before) if (!after.has(key)) out.push({ key, before: value })
  const aliases = (next?.aliases ?? []).filter((a) => !(current?.aliases ?? []).includes(a))
  if (aliases.length) out.push({ key: '别名', after: aliases.join('、') })
  return out
}
