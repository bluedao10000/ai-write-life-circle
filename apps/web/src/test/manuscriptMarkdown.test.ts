import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { findUnsupportedMarkdown, paragraphEntries, paragraphsFromDocument } from '../lib/manuscriptMarkdown'

function createMarkdownEditor(markdown: string): Editor {
  return new Editor({
    element: null,
    extensions: [StarterKit, Markdown],
    content: markdown,
    contentType: 'markdown',
  })
}

describe('Harness Markdown and TipTap round trip', () => {
  it('flags unsupported structures so the manuscript stays read-only rather than silently flattening them', () => {
    expect(findUnsupportedMarkdown('普通段落\n\n> 引用\n\n- 列表\n\n普通硬换行  \n第二行')).toEqual([])
    expect(findUnsupportedMarkdown('| 名称 | 值 |\n| --- | --- |\n| 人物 | 阿青 |')).toContain('table')
    expect(findUnsupportedMarkdown('![封面](cover.png)')).toContain('image')
    expect(findUnsupportedMarkdown('- [ ] 待办')).toContain('task_list')
    expect(findUnsupportedMarkdown('脚注[^1]\n\n[^1]: 来源')).toContain('footnote')
    expect(findUnsupportedMarkdown('<aside>原始 HTML</aside>')).toContain('raw_html')
  })

  it('preserves Markdown block and inline semantics while normalizing only serialization style', () => {
    const source = [
      '普通中文段落，保留「标点」与中文。',
      '',
      '> 引用段落 **强调**',
      '> 引用第二行',
      '',
      '- 列表一',
      '- 列表二',
      '',
      '硬换行第一行  ',
      '硬换行第二行\\',
      '硬换行第三行',
      '',
      '特殊字符：<>& \\*literal\\* \\_under\\_ \\[brackets\\] `code`',
    ].join('\n')
    const editor = createMarkdownEditor(source)
    const firstDocument = editor.state.doc.toJSON()
    const serialized = editor.getMarkdown()
    const reloaded = createMarkdownEditor(serialized)

    expect(serialized).toContain('> 引用段落 **强调**')
    expect(serialized).toContain('- 列表一')
    expect(serialized).toContain('硬换行第一行  \n硬换行第二行  \n硬换行第三行')
    expect(reloaded.state.doc.toJSON()).toEqual(firstDocument)
    expect(paragraphEntries(reloaded.state.doc).length).toBe(6)
    expect(paragraphsFromDocument(reloaded.state.doc)).toContain('特殊字符：<>& *literal* _under_ [brackets] code')

    editor.destroy()
    reloaded.destroy()
  })
})
