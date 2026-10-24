import type { Chapter, Note } from '../../features/vnext/model'
import { Btn, Dot, IconBtn, ago, cn } from './ui'

export type Pending = {
  id: string
  text: string
  tone: 'conflict' | 'ai' | 'quiet'
  run: () => void
}

/** "继续写作" — a quiet hand-off from the author's previous session. Never a gate; dismissible. */
export default function Resume({
  chapter,
  tail,
  nextUp,
  pending,
  editedAt,
  onContinue,
  onThink,
  onSkip,
}: {
  chapter: Chapter
  tail: string[]
  nextUp?: Note
  pending: Pending[]
  editedAt?: number
  onContinue: () => void
  onThink: () => void
  onSkip: () => void
}) {
  return (
    <section aria-label="继续写作" className="fade-up mb-16">
      <div className="flex items-center gap-2 text-ui-sm text-ink-3">
        <span>
          继续写作 · 上次停在{chapter.no ? cn(chapter.no) : ''}
          {chapter.title ? `「${chapter.title}」` : ''}
          {editedAt ? ` · ${ago(editedAt)}` : ''}
        </span>
        <IconBtn icon="x" label="跳过，直接进入正文" onClick={onSkip} className="ml-auto" />
      </div>
      <div className="mt-4 space-y-3">
        {tail.map((p, i) => (
          <p key={i} className="font-prose text-read text-ink-2 indent-8">
            {p}
          </p>
        ))}
      </div>
      {nextUp && (
        <div className="mt-6">
          <div className="text-micro text-ink-3">你留给自己的：下次要写</div>
          <p className="mt-1 font-prose text-ui-lg text-ink">{nextUp.text}</p>
        </div>
      )}
      {pending.length > 0 && (
        <div className="mt-6">
          <div className="text-micro text-ink-3">悬而未决 · 仅与本章有关</div>
          <ul className="mt-1.5 space-y-1">
            {pending.slice(0, 3).map((p) => (
              <li key={p.id}>
                <Btn
                  variant="quiet"
                  size="sm"
                  className="-ml-2 h-auto py-1 text-left"
                  onClick={p.run}
                >
                  <Dot tone={p.tone} />
                  <span className="text-ui text-ink-2">{p.text}</span>
                </Btn>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <Btn variant="primary" onClick={onContinue}>
          继续写
        </Btn>
        <Btn variant="outline" onClick={onThink}>
          先想一想
        </Btn>
        <Btn variant="quiet" onClick={onSkip}>
          直接进入正文
        </Btn>
      </div>
    </section>
  )
}
