import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export type MarkdownRoundTripIssue = 'table' | 'image' | 'task_list' | 'footnote' | 'reference_link' | 'raw_html'

/**
 * Markdown syntax not enabled in the current TipTap schema must stay read-only.
 * This conservative guard prevents an edit/save from silently flattening a
 * structure that the editor cannot round-trip.
 */
export function findUnsupportedMarkdown(markdown: string): MarkdownRoundTripIssue[] {
  const issues = new Set<MarkdownRoundTripIssue>()
  if (/^\s*\|?.+\|.+\|?\s*\r?\n\s*\|?\s*:?-{3,}:?\s*\|/m.test(markdown)) issues.add('table')
  if (/!\[[^\]]*\]\([^\n)]*\)/.test(markdown)) issues.add('image')
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/m.test(markdown)) issues.add('task_list')
  if (/\[\^[^\]]+\]/.test(markdown)) issues.add('footnote')
  if (/^\[[^\]]+\]:\s*\S+/m.test(markdown) || /\[[^\]]+\]\[[^\]]*\]/.test(markdown)) issues.add('reference_link')
  if (/<\/?[A-Za-z][^>]*>/.test(markdown)) issues.add('raw_html')
  return [...issues]
}

/** Build Markdown for legacy/plain-text demo paragraphs without turning punctuation into markup. */
export function plainParagraphsToMarkdown(paragraphs: string[]): string {
  return paragraphs.map((paragraph) => paragraph.replace(/([\\`*_{}\x5b\x5d()#+.!|~>])/g, '\\$1')).join('\n\n')
}

export type ParagraphEntry = { pos: number; node: ProseMirrorNode }

/** Return paragraph nodes in reading order, including paragraphs nested in quotes and lists. */
export function paragraphEntries(doc: ProseMirrorNode): ParagraphEntry[] {
  const entries: ParagraphEntry[] = []
  const visit = (node: ProseMirrorNode, pos: number) => {
    if (node.type.name === 'paragraph') {
      entries.push({ pos, node })
      return
    }
    node.forEach((child, offset) => visit(child, pos + 1 + offset))
  }
  doc.forEach((node, pos) => visit(node, pos))
  return entries
}

/** Plain-text projection for evidence anchors; the Markdown remains the save source of truth. */
export function paragraphsFromDocument(doc: ProseMirrorNode): string[] {
  return paragraphEntries(doc).map(({ node }) => node.textBetween(0, node.content.size, '', '\n'))
}
