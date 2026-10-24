import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ManuscriptEditor from '../components/ManuscriptEditor'
import { usePrototype } from '../features/vnext/usePrototype'
import { initialDoc } from '../mocks/vnextData'

describe('read-only margin evidence', () => {
  it('does not attach an ambiguous quote repeated within one paragraph', () => {
    const { container } = render(<ManuscriptEditor chapterId="test" initial={['测试锚点测试锚点']} initialMarkdown="测试锚点测试锚点" annotations={[{ id: 'test-mark', kind: 'fact', paraIndex: 0, quote: '测试锚点', active: true }]} flash={null} onChange={() => {}} onSelectIssue={() => {}} onSelection={() => {}} onReady={() => {}} />)
    expect(screen.queryByRole('button', { name: '查看本段注记' })).not.toBeInTheDocument()
    expect(container.querySelector('.ann-quote')).toBeNull()
    expect(screen.getByRole('textbox', { name: '正文编辑器' })).toHaveTextContent('测试锚点测试锚点')
  })
  it('marks earlier results stale after the chapter changes even if the anchor quote survives', async () => {
    const chapter = { id: 'c12', no: 12, volume: '第二卷', title: '雨巷', words: 280 }
    const { result, rerender } = renderHook(({ doc }) => usePrototype(true, chapter, doc), { initialProps: { doc: initialDoc } })
    await waitFor(() => expect(result.current.margins).toHaveLength(3))
    expect(result.current.margins[0].state).toBe('fresh')
    rerender({ doc: { ...initialDoc, c12: [...initialDoc.c12, '测试版本变更标记'] } })
    expect(result.current.margins.every((margin) => margin.state === 'stale')).toBe(true)
  })
  it('has no prototype discoveries in API mode', () => {
    const { result } = renderHook(() => usePrototype(false, undefined, {}))
    expect(result.current.entries).toEqual([])
    expect(result.current.margins).toEqual([])
    expect(result.current.thinkingAgent).toBeNull()
  })
})
