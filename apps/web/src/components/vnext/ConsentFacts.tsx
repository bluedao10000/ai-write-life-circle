import type { ReactNode } from 'react'
import { Icon } from './ui'

/**
 * Writer Studio V2 consent layout, shared by Review, Knowledge and Thinking.
 * Presentational only: the caller supplies the real model/endpoint values and
 * keeps its own consent state, plan hash and mutation.
 */
export function ConsentTitle({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <Icon name="shield" className="text-accent" />
      {children}
    </span>
  )
}

export function ConsentFacts({ rows }: { rows: [label: string, value: ReactNode][] }) {
  return (
    <dl className="divide-y divide-line-soft rounded-lg border border-line text-ui">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-3 px-3.5 py-2">
          <dt className="w-14 shrink-0 text-ink-3">{label}</dt>
          <dd className="min-w-0 break-all text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ConsentList({
  title,
  items,
  kind,
}: {
  title: string
  items: ReactNode[]
  kind: 'reads' | 'never'
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-ui-sm font-medium text-ink-3">{title}</h3>
      <ul className={`space-y-1 text-ui-sm ${kind === 'never' ? 'text-ink-2' : 'text-ink'}`}>
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2">
            <Icon
              name={kind === 'reads' ? 'check' : 'x'}
              className={`mt-0.5 ${kind === 'reads' ? 'text-ok' : 'text-ink-3'}`}
            />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
