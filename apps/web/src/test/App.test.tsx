import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../app/App'
import { chapters, initialDoc, knowledge } from '../mocks/demoData'
import { createDemoWriterAgentAdapter } from '../mocks/demoWriterAgent'
import type { WriterAgentAdapter } from '../services/writerAgent'

async function renderStudio(adapter?: WriterAgentAdapter, view: 'read' | 'compose' | 'inspire' = 'compose') {
  const result = render(<App adapter={adapter} />)
  await screen.findByRole('tab', { name: '灵感' })
  if (view === 'inspire') return result
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: '阅读' }))
  if (view === 'compose') await user.click(await screen.findByRole('button', { name: '写作' }))
  return result
}

describe('Writer Agent studio', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('opens 灵感 by default and keeps the space in the URL', async () => {
    const user = userEvent.setup()
    await renderStudio(undefined, 'inspire')
    expect(screen.getByRole('tab', { name: '灵感' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: '写作' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '阅读' }))
    expect(window.location.search).toBe('?view=read')
    await user.click(screen.getByRole('tab', { name: '书' }))
    expect(window.location.search).toBe('?view=book')
    await act(async () => {
      window.history.back()
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    })
    await waitFor(() => expect(screen.getByRole('tab', { name: '阅读' })).toHaveAttribute('aria-selected', 'true'))
  })

  it('maps legacy write/think URLs and reads chapters without editing until compose', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=write')
    render(<App />)
    await waitFor(() => expect(screen.getByRole('tab', { name: '阅读' })).toHaveAttribute('aria-selected', 'true'))
    const editor = await screen.findByRole('textbox', { name: '正文编辑器' })
    expect(editor).toHaveAttribute('contenteditable', 'false')
    await user.click(screen.getByRole('button', { name: '写作' }))
    expect(window.location.search).toBe('?view=read&compose=1')
    expect(screen.getByRole('textbox', { name: '正文编辑器' })).toHaveAttribute('contenteditable', 'true')
    expect(screen.getAllByText(/\d+ 字/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '打字机模式' }))
    expect(localStorage.getItem('writer-agent:typewriter')).toBe('1')
    await user.click(screen.getByRole('button', { name: '阅读' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '正文编辑器' })).toHaveAttribute('contenteditable', 'false'))
    cleanup()
    window.history.replaceState(null, '', '/?view=think')
    render(<App />)
    await waitFor(() => expect(screen.getByRole('tab', { name: '灵感' })).toHaveAttribute('aria-selected', 'true'))
  })

  it('renders the VNext manuscript and reveals chapters only on request', async () => {
    const user = userEvent.setup()
    await renderStudio(undefined, 'read')
    expect(screen.getByRole('textbox', { name: '正文编辑器' })).toHaveAttribute('contenteditable', 'false')
    expect(screen.queryByRole('navigation', { name: '书的地图' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '目录与本章相关' }))
    expect(screen.getByRole('navigation', { name: '书的地图' })).toBeInTheDocument()
  })

  it('keeps development and old four-tab navigation out of the author interface', async () => {
    await renderStudio(undefined, 'read')
    expect(screen.queryByRole('button', { name: '开发说明' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '审查' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '书' })).toBeInTheDocument()
  })

  it('runs the demo thinking challenge workflow and keeps the author in control', async () => {
    const user = userEvent.setup()
    await renderStudio(undefined, 'inspire')
    await user.click(screen.getByRole('tab', { name: '灵感' }))
    await user.type(await screen.findByRole('textbox', { name: '你的想法' }), '测试作者意图')
    await user.click(screen.getByRole('button', { name: '开始思考' }))
    await user.click(await screen.findByRole('button', { name: '理解对了，挑战它' }))
    expect(screen.getByText('挑战 · 不是答案')).toBeInTheDocument()
    expect(screen.getAllByText('原型 · 模拟').length).toBeGreaterThan(0)
  })

  it('supports author correction of a clearly labeled demo understanding', async () => {
    const user = userEvent.setup()
    await renderStudio(undefined, 'inspire')
    await user.click(screen.getByRole('tab', { name: '灵感' }))
    await user.type(await screen.findByRole('textbox', { name: '你的想法' }), '测试想法')
    await user.click(screen.getByRole('button', { name: '开始思考' }))
    await user.click(await screen.findByRole('button', { name: '不对，我来纠正' }))
    await user.type(screen.getByRole('textbox', { name: '纠正 AI 的理解' }), '作者的纠正')
    await user.click(screen.getByRole('button', { name: '提交修正' }))
    expect(screen.getByText('我重新理解为')).toBeInTheDocument()
    expect(screen.getByText('你的纠正')).toBeInTheDocument()
  })

  it('saves TipTap edits in demo mode', async () => {
    const user = userEvent.setup()
    await renderStudio()
    const editor = screen.getByRole('textbox', { name: '正文编辑器' })

    await user.click(editor)
    await user.type(editor, 'author-save-check')

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('writer-agent.v2') || '{}') as { doc?: Record<string, string[]> }
      expect(saved.doc?.c12?.join('')).toContain('author-save-check')
    }, { timeout: 3000 })
  })

  it('keeps unsupported source Markdown read-only and preserves the exact raw text', async () => {
    const adapter = createDemoWriterAgentAdapter({
      chapters,
      knowledge,
      document: initialDoc,
      markdownByChapter: { c12: '| 名称 | 内容 |\n| --- | --- |\n| 阿青 | 原文 |' },
    })
    let saveCount = 0
    const saveChapter = adapter.saveChapter.bind(adapter)
    adapter.saveChapter = async (input) => {
      saveCount += 1
      return saveChapter(input)
    }
    await renderStudio(adapter, 'read')

    expect(screen.getByRole('button', { name: '写作' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('已切换为只读原文以保护内容')
    expect(screen.getByRole('alert').querySelector('pre')?.textContent).toBe('| 名称 | 内容 |\n| --- | --- |\n| 阿青 | 原文 |')
    expect(screen.queryByRole('textbox', { name: '正文编辑器' })).not.toBeInTheDocument()
    expect(saveCount).toBe(0)
  })

  it('waits for Ctrl+S persistence before showing its success toast', async () => {
    const user = userEvent.setup()
    const adapter = createDemoWriterAgentAdapter({ chapters, knowledge, document: initialDoc })
    type SaveResponse = Awaited<ReturnType<WriterAgentAdapter['saveChapter']>>
    let input!: Parameters<WriterAgentAdapter['saveChapter']>[0]
    let resolveSave!: (value: SaveResponse) => void
    adapter.saveChapter = (request) => new Promise((resolve) => {
      input = request
      resolveSave = resolve
    })
    await renderStudio(adapter)
    const editor = screen.getByRole('textbox', { name: '正文编辑器' })

    await user.click(editor)
    await user.type(editor, '等待确认')
    await user.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(resolveSave).toBeTypeOf('function'))
    expect(screen.queryByText('已保存', { exact: true })).not.toBeInTheDocument()

    await act(async () => {
      resolveSave({ projectId: input.projectId, chapterId: input.chapterId, revision: input.revision + 1, sourceHash: input.sourceHash, savedAt: Date.now() })
    })
    await screen.findByText('已保存', { exact: true })
  })

  it('records a demo story judgment without changing chapter prose', async () => {
    const user = userEvent.setup()
    await renderStudio(undefined, 'read')
    const editor = screen.getByRole('textbox', { name: '正文编辑器' })
    const original = editor.textContent
    await user.click(screen.getByRole('button', { name: '注记' }))
    await user.click(await within(screen.getByRole('complementary', { name: '辅助' })).findByText('离京的季节与第 7 章不一致'))
    await user.click(screen.getByRole('button', { name: '进入冲突对照' }))
    await user.click(screen.getByRole('radio', { name: /这是有意为之/ }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(screen.getByRole('textbox', { name: '正文编辑器' }).textContent).toBe(original)
  })

  it('switches the Figma light/dark theme token scope', async () => {
    const user = userEvent.setup()
    await renderStudio()

    await user.click(screen.getByRole('button', { name: '深色主题' }))
    expect(document.querySelector('.dark')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '浅色主题' }))
    expect(document.querySelector('.dark')).not.toBeInTheDocument()
  })
})
