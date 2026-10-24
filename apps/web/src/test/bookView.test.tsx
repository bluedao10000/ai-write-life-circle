import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import BookView, { type BookNav } from '../components/vnext/BookView'
import { initialDoc, initialEntries } from '../mocks/vnextData'
import { relatedFor } from '../mocks/vnextRelevance'

const chapters = [
  {
    id: 'c1',
    no: 1,
    volume: '第一卷',
    title: '灯下',
    words: 100,
  },
  {
    id: 'c2',
    no: 2,
    volume: '第一卷',
    title: '来客',
    words: 100,
  },
]

function renderBook({
  section = 'people',
  knowledgeContent,
}: {
  section?: BookNav['section']
  knowledgeContent?: React.ReactNode
} = {}) {
  return render(<BookHarness section={section} knowledgeContent={knowledgeContent} />)
}

function BookHarness({
  section,
  knowledgeContent,
}: {
  section: BookNav['section']
  knowledgeContent?: React.ReactNode
}) {
  const [nav, setNav] = useState<BookNav>({ section })
  return (
    <BookView
      nav={nav}
      setNav={setNav}
      entries={initialEntries}
      chapters={chapters}
      current={chapters[0]}
      related={relatedFor(chapters[0], initialDoc, initialEntries)}
      notes={[]}
      changes={[]}
      knowledgeContent={knowledgeContent}
      workTitle="测试作品"
      onChapter={vi.fn()}
      onSource={vi.fn()}
      onThink={vi.fn()}
      onPropose={vi.fn()}
      onDecide={vi.fn()}
      onArchive={vi.fn()}
      onBackToWriting={vi.fn()}
    />
  )
}

describe('BookView V2.1 layout', () => {
  it('keeps the knowledge navigation accessible', () => {
    renderBook()
    expect(screen.getByRole('navigation', { name: '书的分区' })).toBeVisible()
    // Author-owned settings and AI manuscript observations are labelled as separate groups.
    expect(screen.getByText('创作设定 · 作者')).toBeVisible()
    expect(screen.getByText('正文观察 · AI')).toBeVisible()
    expect(screen.getByRole('button', { name: '人物设定' })).toBeVisible()
    expect(screen.getByRole('button', { name: '人物' })).toBeVisible()
  })

  it('lets the API knowledge panel own the only main header and scroll region', () => {
    renderBook({
      knowledgeContent: (
        <div aria-label="知识面板测试">
          <h1>人物</h1>
        </div>
      ),
    })
    const panel = screen.getByLabelText('知识面板测试')
    const main = panel.closest('main')
    expect(main).toHaveClass('overflow-hidden')
    expect(main).not.toHaveClass('overflow-auto')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.queryByText('测试作品')).not.toBeInTheDocument()
  })

  it('shows demo entry details after selecting an entity', () => {
    renderBook()
    fireEvent.click(screen.getByRole('button', { name: /^沈砚 / }))
    expect(screen.getByRole('heading', { name: '沈砚', level: 1 })).toBeVisible()
  })
})
