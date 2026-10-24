import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { render, waitFor } from '@testing-library/react'
import type { TextAnchor } from '@writer-agent/contracts'
import { describe, expect, it, vi } from 'vitest'
import { reviewAnchorRanges } from '../lib/reviewAnchor'
import ManuscriptEditor from '../components/ManuscriptEditor'
const anchor = (text: string, quote: string): TextAnchor => ({ revisionId:'fixture',contentHash:`sha256:${'a'.repeat(64)}`,quote,offsetEncoding:'utf16',status:'unique',startUTF16:text.indexOf(quote),endUTF16:text.indexOf(quote)+quote.length })
function editorFor(markdown: string) { return new Editor({element:null,extensions:[StarterKit,Markdown],content:markdown,contentType:'markdown'}) }
describe('fixed revision review anchors', () => {
  it('maps UTF16 emoji offsets and inline formatting without changing the document', () => {
    const text='😀林舟到过北港。 **测试标记**', editor=editorFor(text), before=editor.getJSON()
    const ranges=reviewAnchorRanges(editor.state.doc,text,anchor(text,'林舟到过北港。'))
    expect(ranges).toEqual([{from:3,to:10}])
    expect(reviewAnchorRanges(editor.state.doc,text,anchor(text,'测试标记'))).toHaveLength(1)
    expect(editor.getJSON()).toEqual(before); editor.destroy()
  })
  it('refuses repeated, overlapping, missing, invalid offsets and ambiguous rendered text', () => {
    for(const [text,quote] of [['测试测试','测试'],['aaa','aa'],['同句 **同句**','同句']]) {
      const editor=editorFor(text);expect(reviewAnchorRanges(editor.state.doc,text,anchor(text,quote))).toEqual([]);editor.destroy()
    }
    const text='唯一引文',editor=editorFor(text)
    expect(reviewAnchorRanges(editor.state.doc,text,{...anchor(text,text),startUTF16:1})).toEqual([])
    expect(reviewAnchorRanges(editor.state.doc,'新版本',anchor(text,text))).toEqual([])
    expect(reviewAnchorRanges(editor.state.doc,text,{...anchor(text,text),status:'ambiguous',startUTF16:null,endUTF16:null})).toEqual([])
    editor.destroy()
  })
  it('refreshes decorations without onChange, document changes or moving selection', async () => {
    const text='😀林舟到过北港。',onChange=vi.fn();let editor:Editor|null=null
    const props={chapterId:'CH-008',initial:[text],initialMarkdown:text,flash:null,onChange,onSelectIssue:vi.fn(),onSelection:vi.fn(),onReady:(value:Editor|null)=>{editor=value}}
    const {rerender,container}=render(<ManuscriptEditor {...props} annotations={[]} />)
    await waitFor(()=>expect(editor).toBeDefined())
    const before=editor!.getJSON(),selection=editor!.state.selection.toJSON()
    rerender(<ManuscriptEditor {...props} annotations={[{id:'real-finding',kind:'fact',paraIndex:0,quote:'林舟到过北港。',active:true,reviewAnchor:anchor(text,'林舟到过北港。'),reviewMarkdown:text}]} />)
    await waitFor(()=>expect(container.querySelector('.ann-quote')).not.toBeNull())
    expect(onChange).not.toHaveBeenCalled();expect(editor!.getJSON()).toEqual(before);expect(editor!.state.selection.toJSON()).toEqual(selection)
    rerender(<ManuscriptEditor {...props} annotations={[]} />)
    await waitFor(()=>expect(container.querySelector('.ann-quote')).toBeNull())
    expect(onChange).not.toHaveBeenCalled()
  })
})
