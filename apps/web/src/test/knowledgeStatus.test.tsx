import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import KnowledgeStatus, {
  backfillProgress,
  type KnowledgeStatusPage,
} from '../features/knowledge/KnowledgeStatus'

const base: KnowledgeStatusPage = {
  settings: {
    enabled: true,
    paused: false,
    model: { provider: 'p', model: 'm', baseURL: 'http://x' } as never,
    dailyTokenBudget: 1000,
    dailyJobBudget: 10,
  },
  running: 0,
  pending: 0,
  failed: 0,
  stale: false,
  available: true,
  workerStatus: 'online',
  budgetDay: '2026-10-22',
  budgetAttempts: 0,
  budgetTokens: 0,
}

describe('backfillProgress', () => {
  it('reports nothing when the API does not return progress', () => {
    expect(backfillProgress({})).toBeNull()
    expect(backfillProgress({ completed: 3 })).toBeNull()
    expect(backfillProgress({ chapterTotal: 3 })).toBeNull()
  })

  it('reports nothing for an empty denominator instead of dividing by zero', () => {
    expect(backfillProgress({ completed: 0, chapterTotal: 0 })).toBeNull()
  })

  it('floors the percentage so 100% only means every chapter is done', () => {
    expect(backfillProgress({ completed: 299, chapterTotal: 300 })?.percent).toBe(99)
    expect(backfillProgress({ completed: 300, chapterTotal: 300 })?.percent).toBe(100)
  })

  it('clamps an inconsistent response rather than showing more than 100%', () => {
    expect(backfillProgress({ completed: 9, chapterTotal: 4 })).toEqual({
      done: 4,
      total: 4,
      percent: 100,
    })
  })
})

describe('KnowledgeStatus', () => {
  it('shows the chapter count and a bar while chapters remain', () => {
    render(<KnowledgeStatus page={{ ...base, pending: 2, completed: 2, chapterTotal: 4 }} />)
    expect(screen.getByRole('progressbar', { name: '知识整理进度 50%' })).toBeTruthy()
    expect(screen.getByText('2 / 4 章')).toBeTruthy()
    expect(screen.getByText('有 2 章等待分析')).toBeTruthy()
  })

  it('draws no bar once everything is analysed', () => {
    render(<KnowledgeStatus page={{ ...base, completed: 4, chapterTotal: 4 }} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('知识已同步')).toBeTruthy()
  })

  it('draws no bar and no number against an older API', () => {
    render(<KnowledgeStatus page={{ ...base, pending: 3 }} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/ \/ \d+ 章/)).toBeNull()
    expect(screen.getByText('有 3 章等待分析')).toBeTruthy()
  })

  it('draws no progress while knowledge maintenance is disabled', () => {
    render(
      <KnowledgeStatus
        page={{
          ...base,
          settings: { ...base.settings, enabled: false },
          completed: 1,
          chapterTotal: 4,
        }}
      />,
    )
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('尚未启用自动知识维护')).toBeTruthy()
  })

  it('keeps the offline worker notice and only real budget numbers', () => {
    render(<KnowledgeStatus page={{ ...base, pending: 1, workerStatus: 'offline' }} />)
    expect(screen.getByText(/知识维护服务暂未在线/)).toBeTruthy()
    expect(screen.getByText(/执行 0\/10 次/)).toBeTruthy()
  })
})
