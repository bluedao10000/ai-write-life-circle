import { problemV04Schema } from '@writer-agent/contracts'
import { ApiProblemError, ChapterRevisionConflictError } from '../writerAgent'

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch {
    return null
  }
}

export async function requestApi(path: string, init: RequestInit = {}): Promise<{ body: unknown; response: Response }> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json, application/problem+json')
  const response = await fetch(path, { ...init, headers })
  const body = await readJson(response)

  if (response.status === 401 && import.meta.env.VITE_WRITER_AGENT_AUTH === 'google') {
    window.dispatchEvent(new Event('writer-agent:session-expired'))
  }

  if (!response.ok) {
    const parsed = problemV04Schema.safeParse(body)
    const problem = parsed.success ? parsed.data : undefined
    const requestId = problem?.requestId ?? response.headers.get('x-request-id') ?? undefined
    const message = problem?.detail || `API 请求失败 (${response.status})`
    if (response.status === 409 && problem?.code === 'REVISION_CONFLICT') {
      const current = typeof problem.current === 'object' && problem.current !== null
        ? problem.current as Record<string, unknown>
        : undefined
      throw new ChapterRevisionConflictError(
        message,
        typeof current?.currentRevisionId === 'string' ? current.currentRevisionId : undefined,
        requestId,
      )
    }
    throw new ApiProblemError(message, response.status, problem?.code ?? `HTTP_${response.status}`, requestId, problem?.current)
  }

  return { body, response }
}

export async function getJson(path: string): Promise<unknown> {
  return (await requestApi(path)).body
}

export async function patchJson(path: string, body: unknown): Promise<unknown> {
  return (await requestApi(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).body
}

export async function postJson(path: string, body: unknown, idempotencyKey: string): Promise<unknown> {
  return (await requestApi(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })).body
}
