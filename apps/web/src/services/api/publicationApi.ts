import { emitGrowth } from '../../observability/growth'
import {
  publicationManagementSchema,
  publicationPreviewInputSchema,
  publicationPreviewSchema,
  publicationCommitInputSchema,
  publicationVersionSchema,
  type PublicationPreviewInput,
  type PublicationCommitInput,
} from '@writer-agent/contracts'
import { getJson, requestApi } from './client'
const base = (bookId: string) =>
  `/v1/studio/books/${encodeURIComponent(bookId)}/publication`
export const getPublication = async (bookId: string) =>
  publicationManagementSchema.parse(await getJson(base(bookId)))
export const previewPublication = async (
  bookId: string,
  input: PublicationPreviewInput,
) =>
  publicationPreviewSchema.parse(
    (
      await requestApi(base(bookId) + '/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(publicationPreviewInputSchema.parse(input)),
      })
    ).body,
  )
export const commitPublication = async (
  bookId: string,
  input: PublicationCommitInput,
  key: string,
) => {
  const saved = publicationVersionSchema.parse(
    (
      await requestApi(base(bookId) + '/versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(publicationCommitInputSchema.parse(input)),
      })
    ).body,
  )
  if (input.baseVersionId === null) emitGrowth('first_publication')
  return saved
}
export const transitionPublication = async (
  bookId: string,
  action: 'unlist' | 'relist',
  baseVersionId: string,
  key: string,
) =>
  publicationVersionSchema.parse(
    (
      await requestApi(base(bookId) + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ baseVersionId }),
      })
    ).body,
  )
