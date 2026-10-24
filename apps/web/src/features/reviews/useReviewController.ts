import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewFinding, ReviewPlan, ReviewRun, ReviewType, ReviewFeedbackInput } from '@writer-agent/contracts'
import type { WriterAgentAdapter } from '../../services/writerAgent'
import type { useWorkspaceController } from '../workspace/useWorkspaceController'

type Busy = 'preview' | 'start' | 'feedback' | 'cancel' | 'loading'
type Scope = { projectId: string; chapterId: string; epoch: number }
const message = (e: unknown) => e instanceof Error ? e.message : '审查请求失败，请重试。'
export function useReviewController({ adapter, workspace, available, paneOpen, toast }: {
  adapter: WriterAgentAdapter; workspace: ReturnType<typeof useWorkspaceController>; available: boolean;
  paneOpen: boolean; toast: (text: string) => void;
}) {
  const client = adapter.mode === 'api' ? adapter.reviews : undefined
  const { projectId, current, markdownByChapter, chapterVersions, prepareReview } = workspace
  const generation = useRef(0)
  const scopeRef = useRef<Scope>({ projectId, chapterId: current, epoch: 0 })
  if (scopeRef.current.projectId !== projectId || scopeRef.current.chapterId !== current) {
    scopeRef.current = { projectId, chapterId: current, epoch: scopeRef.current.epoch + 1 }
    generation.current++
  }
  const scope = scopeRef.current
  const [history, setHistory] = useState<{ epoch: number; items: ReviewRun[] }>({ epoch: scope.epoch, items: [] })
  const [selected, setSelected] = useState<{ epoch: number; value: ReviewRun } | null>(null)
  const [planned, setPlanned] = useState<{ epoch: number; value: ReviewPlan; key: string } | null>(null)
  const [types, setTypes] = useState<ReviewType[]>(['character_consistency', 'timeline_consistency'])
  const [pending, setPending] = useState<{ epoch: number; kind: Busy; token: number } | null>(null)
  const pendingRef = useRef(pending)
  const nextToken = useRef(0)
  const [failure, setFailure] = useState<{ epoch: number; text: string } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [active, setActiveId] = useState<string | null>(null)
  const mounted = useRef(true)
  const notified = useRef(new Set<string>())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = selected?.epoch === scope.epoch ? selected.value : null
  const plan = planned?.epoch === scope.epoch ? planned.value : null
  const runs = history.epoch === scope.epoch ? history.items : []
  const busy = pending?.epoch === scope.epoch ? pending.kind : null
  const error = failure?.epoch === scope.epoch ? failure.text : ''
  const selectedRef = useRef(run)
  selectedRef.current = run
  const target = run?.sources.find((source) => source.kind === 'target')
  const version = chapterVersions[current]
  const latest = useRef({ current, markdown: markdownByChapter[current], version })
  latest.current = { current, markdown: markdownByChapter[current], version }
  const runId = run?.runId
  const runStatus = run?.status
  const stale = !!run && (run.stale || target?.excerpt !== markdownByChapter[current]
    || version?.mode !== 'api' || version.revisionId !== run.revisionId || version.contentHash !== run.contentHash)
  const isScope = useCallback((captured: Scope) => mounted.current && captured.epoch === scopeRef.current.epoch
    && captured.projectId === scopeRef.current.projectId && captured.chapterId === scopeRef.current.chapterId, [])
  const isRequest = (captured: Scope, request: number, selectedRun?: string | null) => isScope(captured)
    && request === generation.current && (selectedRun === undefined || (selectedRef.current?.runId ?? null) === selectedRun)
  const begin = (kind: Busy) => {
    if (pendingRef.current?.epoch === scope.epoch) return null
    const operation = { epoch: scope.epoch, kind, token: ++nextToken.current }
    pendingRef.current = operation
    setPending(operation)
    setFailure(null)
    return operation
  }
  const end = (operation: { token: number }) => {
    // A late A completion must never clear B's pending operation.
    if (isScope(scope) && pendingRef.current?.token === operation.token) {
      pendingRef.current = null
      setPending(null)
    }
  }
  const accept = useCallback((value: ReviewRun, captured: Scope) => {
    if (!isScope(captured) || value.projectId !== captured.projectId || value.chapterId !== captured.chapterId) return
    setSelected((prior) => prior?.epoch === captured.epoch && prior.value.runId === value.runId && prior.value.version > value.version
      ? prior : { epoch: captured.epoch, value })
    setHistory((prior) => {
      const all = prior.epoch === captured.epoch ? prior.items : []
      const previous = all.find((item) => item.runId === value.runId)
      const next = previous && previous.version > value.version ? previous : value
      return { epoch: captured.epoch, items: [next, ...all.filter((item) => item.runId !== value.runId)] }
    })
  }, [isScope])
  useEffect(() => {
    if (!client || !paneOpen || !current) return
    const controller = new AbortController()
    const request = ++generation.current
    void client.list(projectId, current, controller.signal).then((items) => {
      if (controller.signal.aborted || !isScope(scope) || request !== generation.current) return
      setHistory({ epoch: scope.epoch, items })
      setSelected((prior) => {
        const value = items.find((item) => prior?.epoch === scope.epoch && item.runId === prior.value.runId) ?? items[0]
        return value ? { epoch: scope.epoch, value } : null
      })
      setFailure(null)
    }).catch((e: unknown) => {
      if (!controller.signal.aborted && isScope(scope) && request === generation.current) setFailure({ epoch: scope.epoch, text: message(e) })
    })
    return () => controller.abort()
  }, [client, projectId, current, paneOpen, refresh, scope, isScope])

  useEffect(() => {
    if (!client || !runId || runStatus !== 'running' && runStatus !== 'queued') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const value = await client.get(projectId, runId, controller.signal)
        if (controller.signal.aborted || !isScope(scope) || selectedRef.current?.runId !== runId) return
        accept(value, scope)
        if (value.status === 'running' || value.status === 'queued') timer = setTimeout(() => void poll(), 1000)
        else if (!notified.current.has(value.runId)) {
          notified.current.add(value.runId)
          toast(value.status === 'completed' ? '审查已完成，可按需查看注记。' : '审查已结束，可查看状态。')
        }
      } catch (e) {
        if (!controller.signal.aborted && isScope(scope) && selectedRef.current?.runId === runId) setFailure({ epoch: scope.epoch, text: `${message(e)} 没有确认结果已保存，请刷新核对。` })
      }
    }
    timer = setTimeout(() => void poll(), 400)
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [client, projectId, runId, runStatus, accept, toast, refresh, scope, isScope])

  const prepare = async (nextTypes = types) => {
    if (!client || !available) { toast('服务端尚未配置可用模型，真实审查不可用。'); return }
    if (nextTypes.length === 0) { toast('至少选择一种审查类型。'); return }
    const operation = begin('preview')
    if (!operation) return
    setTypes(nextTypes)
    const request = ++generation.current
    try {
      const snapshot = await prepareReview(current)
      if (!isRequest(scope, request)) return
      const value = await client.preview(projectId, current, { revisionId: snapshot.revisionId, contentHash: snapshot.contentHash, reviewTypes: nextTypes })
      if (isRequest(scope, request)) setPlanned({ epoch: scope.epoch, value, key: crypto.randomUUID() })
    } catch (e) {
      if (isRequest(scope, request)) { setFailure({ epoch: scope.epoch, text: message(e) }); toast(message(e)) }
    } finally { end(operation) }
  }
  const start = async () => {
    const consentKey = planned?.epoch === scope.epoch ? planned.key : null
    if (!client || !plan || !consentKey) return false
    const operation = begin('start')
    if (!operation) return false
    const request = ++generation.current, selectedRun = runId ?? null
    try {
      const snapshot = await prepareReview(plan.chapterId)
      if (!isRequest(scope, request, selectedRun)) return false
      if (snapshot.revisionId !== plan.revisionId || snapshot.contentHash !== plan.contentHash) throw new Error('正文已变化，请重新预览并确认审查范围。')
      const value = await client.start(projectId, plan.chapterId, {
        revisionId: plan.revisionId, contentHash: plan.contentHash, reviewTypes: plan.reviewTypes,
        consent: { confirmed: true, planHash: plan.planHash },
      }, consentKey)
      if (!isRequest(scope, request, selectedRun)) return false
      accept(value, scope); setPlanned(null); setActiveId(null)
      return true
    } catch (e) {
      if (isRequest(scope, request, selectedRun)) { setFailure({ epoch: scope.epoch, text: message(e) }); toast(message(e)) }
      return false
    } finally { end(operation) }
  }
  const cancel = async () => {
    if (!client || !run) return
    const operation = begin('cancel')
    if (!operation) return
    const request = ++generation.current
    try {
      const value = await client.cancel(projectId, run.runId, crypto.randomUUID())
      if (isRequest(scope, request, run.runId)) accept(value, scope)
    } catch (e) { if (isRequest(scope, request, run.runId)) setFailure({ epoch: scope.epoch, text: message(e) }) }
    finally { end(operation) }
  }
  const feedback = async (findingId: string, choice: ReviewFeedbackInput['choice']) => {
    if (!client || !run) return
    const operation = begin('feedback')
    if (!operation) return
    const request = ++generation.current
    try {
      const value = await client.feedback(projectId, run.runId, findingId, { choice, baseVersion: run.version }, crypto.randomUUID())
      if (isRequest(scope, request, run.runId)) { accept(value, scope); toast('作者反馈已保存。') }
    } catch (e) {
      if (isRequest(scope, request, run.runId)) { setFailure({ epoch: scope.epoch, text: `${message(e)} 请刷新后核对反馈状态。` }); setRefresh((value) => value + 1) }
    } finally { end(operation) }
  }
  const choose = async (id: string) => {
    if (!client) return
    const operation = begin('loading')
    if (!operation) return
    const request = ++generation.current
    try {
      const value = await client.get(projectId, id)
      if (isRequest(scope, request)) { accept(value, scope); setActiveId(null) }
    } catch (e) { if (isRequest(scope, request)) setFailure({ epoch: scope.epoch, text: message(e) }) }
    finally { end(operation) }
  }
  const revalidate = async (id: string): Promise<ReviewRun | null> => {
    if (!client || !run) return null
    const request = ++generation.current
    try {
      const value = await client.get(projectId, run.runId)
      if (!isRequest(scope, request, run.runId)) return null
      accept(value, scope)
      const local = latest.current
      const target = value.sources.find((source) => source.kind === 'target')
      if (value.stale || value.chapterId !== local.current || local.version?.mode !== 'api' || local.version.revisionId !== value.revisionId || local.version.contentHash !== value.contentHash || target?.excerpt !== local.markdown || !value.findings.some((finding) => finding.findingId === id)) {
        toast('正文或证据已变化，旧注记不能定位到当前正文。'); return null
      }
      return value
    } catch (e) { if (isRequest(scope, request, run.runId)) setFailure({ epoch: scope.epoch, text: message(e) }); return null }
  }
  const finding = (id: string): ReviewFinding | undefined => run?.findings.find((item) => item.findingId === id)
  return { available: available && !!client, runs, run, plan, consentSessionId: plan ? planned?.key : null,
    closePlan: () => { if (busy !== 'start') { generation.current++; setPlanned(null) } }, types, busy, error, stale, prepare, start, cancel, feedback,
    activeId: run?.findings.some((item) => item.findingId === active) ? active : null, setActiveId, choose, finding, revalidate,
    refresh: () => setRefresh((value) => value + 1),
  }
}
