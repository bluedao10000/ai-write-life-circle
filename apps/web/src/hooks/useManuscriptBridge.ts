import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { paragraphsFromDocument } from '../lib/manuscriptMarkdown'

/** Read-only projection of the mounted editor; never participates in Markdown persistence. */
export function useManuscriptBridge(chapterId: string) {
  const editor = useRef<Editor | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const [projection, setProjection] = useState<{
    chapterId: string
    paragraphs: string[]
    words: number
  } | null>(null)
  const onReady = useCallback(
    (next: Editor | null) => {
      cleanup.current?.()
      cleanup.current = null
      editor.current = next
      if (!next) {
        setProjection(null)
        return
      }
      const read = () => {
        if (next.isDestroyed) return
        setProjection({
          chapterId,
          paragraphs: paragraphsFromDocument(next.state.doc),
          words: next.getText().replace(/\s/g, '').length,
        })
      }
      read()
      next.on('update', read)
      cleanup.current = () => next.off('update', read)
    },
    [chapterId],
  )
  useEffect(() => () => cleanup.current?.(), [])
  return {
    editor,
    onReady,
    paragraphs: projection?.chapterId === chapterId ? projection.paragraphs : null,
    words: projection?.chapterId === chapterId ? projection.words : null,
  }
}
