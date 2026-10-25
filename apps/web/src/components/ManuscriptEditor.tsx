import { useEffect, useMemo, useRef } from 'react'
import { useEditor, EditorContent, Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { TextAnchor } from '@writer-agent/contracts'
import { reviewAnchorRanges } from '../lib/reviewAnchor'
import type { Proposal } from '../types'
import { findUnsupportedMarkdown, paragraphEntries, paragraphsFromDocument } from '../lib/manuscriptMarkdown'

export type Annotation = { id: string; kind: Proposal['kind']; paraIndex: number; quote: string; active: boolean; reviewAnchor?: TextAnchor; reviewMarkdown?: string }
export type Flash = { paraIndex: number; quote?: string; nonce: number; reviewAnchor?: TextAnchor; reviewMarkdown?: string } | null

const key = new PluginKey('annotations')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const toHTML = (paras: string[]) => paras.map((p) => `<p>${esc(p)}</p>`).join('')
export const fromDoc = paragraphsFromDocument

/** Quote anchors must be unique; never silently jump to the first similar paragraph. */
function locate(doc: PMNode, paraIndex: number, quote?: string): { pos: number; node: PMNode } | null {
  const entries = paragraphEntries(doc)
  if (!quote) return entries[paraIndex] ?? null
  const matches = entries.filter(({ node }) => node.textContent.includes(quote))
  return matches.length === 1 && matches[0].node.textContent.split(quote).length === 2 ? matches[0] : null
}

function build(doc: PMNode, anns: Annotation[], flash: Flash, onSelect: (id: string) => void): DecorationSet {
  const decos: Decoration[] = []
  const seen = new Set<number>()
  for (const a of anns) {
    if (a.reviewAnchor) {
      const ranges = reviewAnchorRanges(doc, a.reviewMarkdown ?? '', a.reviewAnchor)
      if (ranges.length === 0) continue
      decos.push(Decoration.widget(ranges[0].from, () => {
        const mark = document.createElement('button')
        mark.type = 'button'; mark.className = 'margin-dot tone-ai'; mark.contentEditable = 'false'
        mark.setAttribute('aria-label', '查看本段注记')
        mark.addEventListener('mousedown', (event) => { event.preventDefault(); onSelect(a.id) })
        mark.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(a.id) } })
        return mark
      }, { key: a.id, side: -1, ignoreSelection: true }))
      if (a.active) for (const range of ranges) decos.push(Decoration.inline(range.from, range.to, { class: 'ann-quote tone-ai', 'data-review-highlight': a.id }))
      continue
    }
    const loc = locate(doc, a.paraIndex, a.quote)
    if (!loc) continue
    const tone = a.kind === 'fact' ? 'conflict' : a.kind === 'suggestion' ? 'ai' : 'quiet'
    if (!seen.has(loc.pos)) {
      seen.add(loc.pos)
      decos.push(Decoration.widget(loc.pos + 1, () => {
        const mark = document.createElement('span')
        mark.className = `margin-dot tone-${tone}${a.active ? ' is-active' : ''}`
        mark.contentEditable = 'false'; mark.tabIndex = 0
        mark.setAttribute('role', 'button'); mark.setAttribute('aria-label', '查看本段注记')
        mark.addEventListener('mousedown', (event) => { event.preventDefault(); onSelect(a.id) })
        mark.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(a.id) } })
        return mark
      }, { key: `${a.id}-${a.active}`, side: -1, ignoreSelection: true }))
    }
    if (a.active) {
      decos.push(Decoration.node(loc.pos, loc.pos + loc.node.nodeSize, { class: `ann-active tone-${tone}` }))
      const off = loc.node.textContent.indexOf(a.quote)
      if (off >= 0) decos.push(Decoration.inline(loc.pos + 1 + off, loc.pos + 1 + off + a.quote.length, { class: `ann-quote tone-${tone}` }))
    }
  }
  if (flash?.reviewAnchor) {
    for (const range of reviewAnchorRanges(doc, flash.reviewMarkdown ?? '', flash.reviewAnchor)) decos.push(Decoration.inline(range.from, range.to, { class: 'ann-flash' }))
  } else if (flash) {
    const loc = locate(doc, flash.paraIndex, flash.quote)
    if (loc) decos.push(Decoration.node(loc.pos, loc.pos + loc.node.nodeSize, { class: 'ann-flash' }))
  }
  return DecorationSet.create(doc, decos)
}

type Props = {
  chapterId: string
  initial: string[]
  initialMarkdown?: string
  annotations: Annotation[]
  flash: Flash
  onChange: (paras: string[], markdown: string) => void
  onSelectIssue: (id: string) => void
  onSelection: (text: string, paraIndex: number) => void
  onReady: (e: Editor | null) => void
  /** Reading mode mounts the same document read-only; saving paths stay unchanged. */
  editable?: boolean
  /** Keep the caret line near the vertical centre while composing. */
  typewriter?: boolean
  /** Viewport position of a non-empty selection, for the floating selection bar. */
  onSelectionRect?: (text: string, rect: { left: number; top: number } | null) => void
}

export default function ManuscriptEditor({ chapterId, initial, initialMarkdown, annotations, flash, onChange, onSelectIssue, onSelection, onReady, editable = true, typewriter = false, onSelectionRect }: Props) {
  const unsupportedMarkdown = useMemo(() => findUnsupportedMarkdown(initialMarkdown ?? ''), [initialMarkdown])
  const annRef = useRef(annotations)
  const flashRef = useRef(flash)
  const cb = useRef({ onChange, onSelectIssue, onSelection, onSelectionRect })
  cb.current = { onChange, onSelectIssue, onSelection, onSelectionRect }

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Markdown,
        Extension.create({
          name: 'annotations',
          addProseMirrorPlugins() {
            return [
              new Plugin({
                key,
                props: {
                  decorations: (state) => build(state.doc, annRef.current, flashRef.current, (id) => cb.current.onSelectIssue(id)),
                  handleClick: (_view, _pos, ev) => {
                    const el = (ev.target as HTMLElement).closest('[data-issue]')
                    if (el) cb.current.onSelectIssue(el.getAttribute('data-issue')!)
                    return false
                  },
                },
              }),
            ]
          },
        }),
      ],
      editable,
      content: initialMarkdown ?? toHTML(initial),
      contentType: initialMarkdown !== undefined ? 'markdown' : 'html',
      editorProps: { attributes: { class: 'manuscript font-prose outline-none', 'aria-label': '正文编辑器', spellcheck: 'false' } },
      onUpdate: ({ editor }) => cb.current.onChange(fromDoc(editor.state.doc), editor.getMarkdown()),
      onSelectionUpdate: ({ editor }) => {
        const { from, to } = editor.state.selection
        const text = editor.state.doc.textBetween(from, to, '\n')
        const paraIndex = paragraphEntries(editor.state.doc).findIndex(({ pos, node }) => from >= pos && from <= pos + node.nodeSize)
        cb.current.onSelection(text, Math.max(0, paraIndex))
        if (cb.current.onSelectionRect) {
          const trimmed = text.trim()
          if (trimmed.length > 1) {
            const c = editor.view.coordsAtPos(from)
            cb.current.onSelectionRect(trimmed, { left: c.left, top: c.top })
          } else cb.current.onSelectionRect('', null)
        }
      },
    },
    [chapterId],
  )

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable !== editable) editor.setEditable(editable, false)
  }, [editor, editable])

  // Typewriter scrolling: centre the caret inside the nearest scroll container.
  useEffect(() => {
    if (!editor || !typewriter || !editable) return
    const centre = () => {
      if (editor.isDestroyed) return
      const container = editor.view.dom.closest('.scroll')
      if (!(container instanceof HTMLElement)) return
      const caret = editor.view.coordsAtPos(editor.state.selection.head)
      const box = container.getBoundingClientRect()
      const delta = caret.top - (box.top + box.height / 2)
      if (Math.abs(delta) > 24) container.scrollBy({ top: delta, behavior: 'smooth' })
    }
    editor.on('selectionUpdate', centre)
    editor.on('update', centre)
    return () => {
      editor.off('selectionUpdate', centre)
      editor.off('update', centre)
    }
  }, [editor, typewriter, editable])

  useEffect(() => {
    if (unsupportedMarkdown.length > 0) onReady(null)
    else if (editor) onReady(editor)
  }, [editor, onReady, unsupportedMarkdown])

  // Annotation layer refresh — a meta-only transaction, document unchanged.
  useEffect(() => {
    annRef.current = annotations
    flashRef.current = flash
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, true))
  }, [annotations, flash, editor])

  // Scroll to flashed / active paragraph.
  useEffect(() => {
    if (!editor || !flash) return
    const t = setTimeout(() => {
      if (flash.reviewAnchor) {
        const range = reviewAnchorRanges(editor.state.doc, flash.reviewMarkdown ?? '', flash.reviewAnchor)[0]
        if (!range) return
        const node = editor.view.domAtPos(range.from).node
        const element = node instanceof HTMLElement ? node : node.parentElement
        element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      const loc = locate(editor.state.doc, flash.paraIndex, flash.quote)
      if (!loc) return
      const dom = editor.view.nodeDOM(loc.pos) as HTMLElement | null
      dom?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    return () => clearTimeout(t)
  }, [flash, editor])

  if (unsupportedMarkdown.length > 0) {
    return (
      <section role="alert" className="rounded border p-4 text-sm" style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}>
        <p>此章节包含当前编辑器无法保证无损往返的 Markdown，已切换为只读原文以保护内容。请保留原始 Markdown，待支持该格式后再编辑。</p>
        <pre className="manuscript mt-3 whitespace-pre-wrap">{initialMarkdown}</pre>
      </section>
    )
  }

  return <EditorContent editor={editor} />
}
