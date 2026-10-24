import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MemoryView } from '@writer-agent/contracts'
import KnowledgeChip, { chipState } from '../features/knowledge/KnowledgeChip'

const view = (patch: Partial<MemoryView> = {}): MemoryView =>
  ({
    settings: { enabled: true, paused: false },
    pending: 0,
    running: 0,
    failed: 0,
    workerStatus: 'online',
    ...patch,
  }) as MemoryView

describe('chipState', () => {
  it('says 未开启 when maintenance is off', () => {
    expect(chipState(view({ settings: { enabled: false, paused: false } as never }))).toEqual({
      text: '未开启',
      tone: 'quiet',
    })
  })

  it('prefers paused over any outstanding work', () => {
    const s = chipState(view({ settings: { enabled: true, paused: true } as never, pending: 5 }))
    expect(s).toEqual({ text: '已暂停', tone: 'warn' })
  })

  it('reports an offline worker only while work is waiting', () => {
    expect(chipState(view({ pending: 2, workerStatus: 'offline' })).text).toBe('离线')
    expect(chipState(view({ workerStatus: 'offline' })).text).toBe('已同步')
  })

  it('surfaces failures in the danger tone', () => {
    expect(chipState(view({ failed: 1 }))).toEqual({ text: '有失败', tone: 'danger' })
  })

  it('shows a real percentage while backfill runs', () => {
    expect(chipState(view({ pending: 3, completed: 1, chapterTotal: 4 })).text).toBe('25%')
  })

  it('never invents a percentage when the API reports no progress', () => {
    expect(chipState(view({ running: 1 }))).toEqual({ text: '整理中', tone: 'ai' })
  })

  it('is 已同步 when idle', () => {
    expect(chipState(view({ completed: 4, chapterTotal: 4 }))).toEqual({
      text: '已同步',
      tone: 'ok',
    })
  })
})

describe('KnowledgeChip', () => {
  it('exposes the status in its accessible name', () => {
    render(<KnowledgeChip view={view({ pending: 1, completed: 1, chapterTotal: 2 })} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: '知识维护：50%' })).toBeTruthy()
  })
})
