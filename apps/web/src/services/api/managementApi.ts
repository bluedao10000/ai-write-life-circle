import {
  deleteBookInputSchema,
  importCommitInputSchema,
  importPreviewSchema,
  managedBooksSchema,
  managedBookSchema,
  structureInputSchema,
  type ImportCommitInput,
  type DeleteBookInput,
  type StructureInput,
} from '@writer-agent/contracts'
import { getJson, requestApi } from './client'
export const managementApi = {
  async list() {
    return managedBooksSchema.parse(await getJson('/v1/studio/books')).items
  },
  async mutate(bookId: string | null, input: StructureInput, key: string) {
    return managedBookSchema.parse(
      (
        await requestApi(
          `/v1/studio/books${bookId ? `/${encodeURIComponent(bookId)}/structure` : ''}`,
          {
            method: bookId ? 'PUT' : 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body: JSON.stringify(structureInputSchema.parse(input)),
          },
        )
      ).body,
    )
  },
  async deleteBook(bookId: string, input: DeleteBookInput, key: string) {
    await requestApi(`/v1/studio/books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(deleteBookInputSchema.parse(input)),
    })
  },
  async uploadEPUB(file: File, key: string) {
    const body = new FormData()
    body.set('file', file)
    return importPreviewSchema.parse(
      (
        await requestApi('/v1/studio/imports', {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body,
        })
      ).body,
    )
  },
  async getImport(importId: string) {
    return importPreviewSchema.parse(
      (
        await requestApi(`/v1/studio/imports/${encodeURIComponent(importId)}`)
      ).body,
    )
  },
  async commitImport(importId: string, input: ImportCommitInput, key: string) {
    return managedBookSchema.parse(
      (
        await requestApi(`/v1/studio/imports/${encodeURIComponent(importId)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify(importCommitInputSchema.parse(input)),
        })
      ).body,
    )
  },
  async deleteImport(importId: string) {
    await requestApi(`/v1/studio/imports/${encodeURIComponent(importId)}`, {
      method: 'DELETE',
    })
  },
}
