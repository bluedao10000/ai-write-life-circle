/** Hash the exact serialized paragraph list so saves and reviews bind to a revision. */
export async function hashParagraphs(paragraphs: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(paragraphs))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

/** Bind manuscript revisions to the serialized Markdown, including formatting and block structure. */
export const hashMarkdown = hashText
