import type { Chapter, Document } from '@writer-agent/contracts'

const count = (ps: string[] = []) => ps.join('').replace(/\s/g, '').length

export default function ChapterNavigator({ chapters, doc, current, onPick, onNav, onCollapse, projectTitle, adapterMode }: {
  chapters: Chapter[]
  doc: Document; current: string; onPick: (id: string) => void
  onNav: (n: string) => void; onCollapse: () => void
  projectTitle: string; adapterMode: 'demo' | 'api'
}) {
  const total = chapters.reduce((sum, chapter) => sum + (doc[chapter.id] ? count(doc[chapter.id]) : chapter.wordCount ?? 0), 0)
  const volumes = [...new Set(chapters.map((c) => c.volume))]
  const nav: [string, string][] = [['knowledge', '作品知识库'], ['decisions', '提案与决策'], ['agent', 'Agent 工作台']]
  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--surface-2)' }}>
      <div className="flex items-start px-5 pt-5 pb-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] tracking-widest" style={{ color: 'var(--ink-3)' }}>WRITER AGENT</div>
          <div className="font-prose mt-1 text-[17px] font-semibold">{projectTitle}</div>
          <div className="mt-1 text-xs" style={{ color: 'var(--ink-3)' }}>{adapterMode === 'demo' ? '长篇 · 演示稿' : '作品原文 · 未提交草稿'} {total.toLocaleString()} 字</div>
        </div>
        <button type="button" onClick={onCollapse} className="btn ghost rounded px-1.5 text-sm" style={{ color: 'var(--ink-3)' }} title="折叠导航 ⌘⇧\" aria-label="折叠导航">⟨</button>
      </div>
      <nav className="px-2" aria-label="模块">
        <div className="flex items-center rounded-md px-3 py-1.5 text-[13px]" style={{ background: 'var(--surface)', boxShadow: 'var(--shadow)' }}>沉浸式写作</div>
        {nav.map(([k, n]) => (
          <button key={k} type="button" onClick={() => onNav(k)} className="btn ghost flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-[13px]" style={{ color: 'var(--ink-2)' }}>
            {n}
          </button>
        ))}
      </nav>
      <div className="scroll mt-5 min-h-0 flex-1 overflow-auto px-2 pb-4" role="tree" aria-label="章节目录">
        <div className="px-3 pb-1 text-[11px] font-medium" style={{ color: 'var(--ink-3)' }}>章节目录</div>
        {volumes.map((v) => (
          <div key={v} className="mb-2">
            <div className="px-3 py-1 text-xs font-medium" style={{ color: 'var(--ink-2)' }}>{v}</div>
            {chapters.filter((c) => c.volume === v).map((c) => (
              <button
                key={c.id} type="button" role="treeitem" aria-selected={c.id === current} onClick={() => onPick(c.id)}
                className="btn ghost font-prose flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-5 text-left text-[13px]"
                style={c.id === current ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : { color: 'var(--ink-2)' }}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="font-sans text-[10.5px]" style={{ color: 'var(--ink-3)' }}>{doc[c.id] ? count(doc[c.id]) : c.wordCount ?? 0}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
