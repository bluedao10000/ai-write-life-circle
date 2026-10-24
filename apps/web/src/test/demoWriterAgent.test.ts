import { beforeEach, describe, expect, it } from 'vitest'
import { createDemoWriterAgentAdapter } from '../mocks/demoWriterAgent'
import { chapters, initialDoc, knowledge } from '../mocks/demoData'
import { hashMarkdown } from '../lib/sourceHash'
import { plainParagraphsToMarkdown } from '../lib/manuscriptMarkdown'

describe('demo adapter', () => {
  const adapter = createDemoWriterAgentAdapter({ chapters, knowledge, document: initialDoc })

  beforeEach(() => localStorage.clear())

  it('labels every generated response as demo data', async () => {
    const workspace = await adapter.loadWorkspace('demo-project')
    const markdown = plainParagraphsToMarkdown(initialDoc.c12)
    const review = await adapter.runReview({
      projectId: 'demo-project', chapterId: 'c12', paragraphs: initialDoc.c12, markdown, revision: 0,
      sourceHash: await hashMarkdown(markdown), reviewRunId: 'review-1',
      scope: ['timeline', 'characters', 'foreshadowing', 'worldbuilding'], sequence: workspace.sequence,
    })
    const chat = await adapter.sendMessage({ projectId: 'demo-project', chapterId: 'c12', text: '沈砚在想什么？' })
    const challenge = await adapter.challenge({ projectId: 'demo-project', intent: '测试观点', previousRounds: [] })

    expect(review.demo).toBe(true)
    expect(review.proposals.every((proposal) => proposal.reviewRunId === 'review-1' && proposal.sourceHash === review.sourceHash)).toBe(true)
    expect(chat.demo).toBe(true)
    expect(challenge.demo).toBe(true)
  })

  it('returns the next chapter revision after an explicit author save', async () => {
    const workspace = await adapter.loadWorkspace('demo-project')
    const paragraphs = ['作者明确保存的段落。']
    const markdown = plainParagraphsToMarkdown(paragraphs)
    const response = await adapter.saveChapter({
      projectId: 'demo-project', chapterId: 'c14', paragraphs, markdown,
      revision: workspace.chapterVersions.c14.mode === 'demo' ? workspace.chapterVersions.c14.revision : 0,
      sourceHash: await hashMarkdown(markdown),
    })
    expect(response.revision).toBe(1)
    expect(response.sourceHash).toBe(await hashMarkdown(markdown))
  })
})
