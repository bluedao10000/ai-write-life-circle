// VNext domain model (prototype). Internal ids exist for engineering but are never shown to authors.

export type Chapter = {
  id: string
  no: number
  volume: string
  title: string
  setting?: string
  words: number
  /** true when the prototype carries no prose for this chapter (long-form scale demo only). */
  placeholder?: boolean
}

export type Doc = Record<string, string[]>

/** A cited source. `state` tells whether the quote still matches the current chapter text. */
export type Source = {
  label: string
  quote: string
  chapterId?: string
  para?: number
  entryId?: string
  state: 'ok' | 'stale' | 'missing'
  reviewSourceId?: string
}

export type CanonCandidateContext = { entryId?: string; sources: Source[]; reason: string }

export type Tone = 'conflict' | 'ai' | 'quiet'

/** A margin annotation: Agent observation anchored to a paragraph. Never edits prose. */
export type Margin = {
  id: string
  chapterId: string
  para: number
  quote: string
  tone: Tone
  title: string
  facts: Source[]
  inference: string
  question: string
  alternativeExplanation?: string
  locationLabel?: string
  /** fresh: computed on current text. stale: text changed after analysis. source-missing: a cited source is not on file. */
  state: 'fresh' | 'stale' | 'source-missing'
  conflictId?: string
  entryId?: string
}

export type EntryKind = 'person' | 'rule' | 'place' | 'fact' | 'thread' | 'plot'
export type EntryStatus = 'confirmed' | 'tentative' | 'open'

export type Change = { at: string; text: string; chapter?: number; simulated?: boolean }

export type Entry = {
  id: string
  kind: EntryKind
  name: string
  summary: string
  status: EntryStatus
  firstSeen?: number
  lastConfirmed?: number
  chapters: number[]
  related: string[]
  fields: { label: string; value: string; source?: Source }[]
  sources: Source[]
  history: Change[]
  /** foreshadowing: planted chapter and an author-chosen window to pay it off. */
  thread?: { planted: number; window: [number, number]; state: 'open' | 'paid' }
  demo?: boolean
}

export type Note = {
  id: string
  text: string
  at: number
  origin: 'quick' | 'margin' | 'thinking' | 'conflict'
  chapterId?: string
  para?: number
  quote?: string
  sessionId?: string
  /** "下次要写" is the author's own hand-off to their future self. */
  nextUp?: boolean
  canonChangeId?: string
  archived?: boolean
}

export type CanonChange = {
  id: string
  noteId?: string
  entryId: string
  field: string
  current: string
  proposed: string
  reason: string
  sources: Source[]
  chapters: number[]
  impact: string[]
  status: 'draft' | 'confirmed' | 'deferred' | 'abandoned'
  decidedAt?: number
}

export type StoryConflict = {
  id: string
  title: string
  a: Source
  b: Source
  extra?: Source
  analysis: string
  readings: string[]
  question: string
  resolution?: 'growth' | 'edit-text' | 'edit-canon' | 'intentional'
}

export type ThinkBlock =
  | { kind: 'idea'; text: string; quote?: string }
  | { kind: 'understand'; items: { text: string; inferred: boolean }[]; revised?: boolean }
  | { kind: 'correct'; text: string }
  | { kind: 'challenge'; items: { tag: string; text: string }[]; questions: string[] }
  | {
      kind: 'research'
      items: { work: string; mechanism: string; cite?: string; verified: boolean }[]
    }
  | { kind: 'conclusion'; text: string; noteId: string }

export type Session = {
  id: string
  topic: string
  at: number
  chapterId?: string
  blocks: ThinkBlock[]
}

export type SaveState =
  | 'loading'
  | 'saved'
  | 'dirty'
  | 'saving'
  | 'failed'
  | 'recovery'
  | 'conflict'
  | 'readonly'

export type View = 'write' | 'book' | 'think' | 'spec'
