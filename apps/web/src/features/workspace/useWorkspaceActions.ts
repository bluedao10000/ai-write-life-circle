import { useCallback, useMemo } from 'react'
import type { ChallengeRequest, ChatRequest, RunReviewRequest, SaveChapterRequest } from '@writer-agent/contracts'
import type { WriterAgentAdapter } from '../../services/writerAgent'

/** Application workflow boundary between UI events and whichever API adapter is active. */
export function useWorkspaceActions(adapter: WriterAgentAdapter) {
  const saveChapter = useCallback((input: SaveChapterRequest) => adapter.saveChapter(input), [adapter])

  const reviewChapter = useCallback((input: RunReviewRequest) => adapter.runReview(input), [adapter])

  const sendMessage = useCallback((input: ChatRequest) => adapter.sendMessage(input), [adapter])

  const challenge = useCallback((input: ChallengeRequest) => adapter.challenge(input), [adapter])

  return useMemo(() => ({ saveChapter, reviewChapter, sendMessage, challenge }), [saveChapter, reviewChapter, sendMessage, challenge])
}
