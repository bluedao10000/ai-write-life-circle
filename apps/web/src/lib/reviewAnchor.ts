import type { Node as PMNode } from '@tiptap/pm/model'
import type { TextAnchor } from '@writer-agent/contracts'

/** UTF-16 raw Markdown offsets are validated before mapping into ProseMirror positions. */
export function reviewAnchorRanges(doc: PMNode, markdown: string, anchor: TextAnchor): { from: number; to: number }[] {
  if (anchor.startUTF16 !== null && anchor.endUTF16 !== null && (anchor.startUTF16 < 0 || anchor.endUTF16 > markdown.length || anchor.endUTF16 - anchor.startUTF16 !== anchor.quote.length)) return []
  if (anchor.status !== 'unique' || anchor.offsetEncoding !== 'utf16' || anchor.startUTF16 === null || anchor.endUTF16 === null
    || markdown.slice(anchor.startUTF16, anchor.endUTF16) !== anchor.quote || !anchor.quote
    || markdown.indexOf(anchor.quote) !== anchor.startUTF16 || markdown.indexOf(anchor.quote, anchor.startUTF16 + 1) !== -1) return []
  let text = ''
  const positions: number[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (text.length) { text += '\n'; positions.push(-1) }
    node.descendants((child, offset) => {
      if (child.isText && child.text) {
        text += child.text
        for (let i = 0; i < child.text.length; i++) positions.push(pos + 1 + offset + i)
      } else if (child.type.name === 'hardBreak') { text += '\n'; positions.push(pos + 1 + offset) }
    })
    return false
  })
  const start = text.indexOf(anchor.quote)
  if (start < 0 || text.indexOf(anchor.quote, start + 1) !== -1) return []
  const ranges: { from: number; to: number }[] = []
  for (const position of positions.slice(start, start + anchor.quote.length)) {
    if (position < 0) continue
    const prior = ranges[ranges.length - 1]
    if (prior?.to === position) prior.to++
    else ranges.push({ from: position, to: position + 1 })
  }
  return ranges
}
