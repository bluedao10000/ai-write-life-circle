import { createContext, useContext, type ReactNode } from 'react'
import { Btn, Icon } from '../../components/vnext/ui'

export type WorkPage = 'desk' | 'chapters' | 'history'
export const WorkNavigation = createContext<{ page: WorkPage | null; open: (page: WorkPage | null) => void; historyAvailable: boolean } | null>(null)
export const useWorkNavigation = () => useContext(WorkNavigation)
export function readWorkPage(): WorkPage | null {
  const page = new URLSearchParams(window.location.search).get('page')
  return page === 'desk' || page === 'chapters' || page === 'history' ? page : null
}

export default function StudioPage({ eyebrow, title, meta, actions, onBack, backLabel = '作品总览', children }: {
  eyebrow: string; title: ReactNode; meta?: ReactNode; actions?: ReactNode
  onBack: () => void; backLabel?: string; children: ReactNode
}) {
  return (
    <main className="scroll min-h-0 flex-1 overflow-auto bg-page">
      <div className="mx-auto w-full max-w-site px-5 pt-8 pb-32 sm:px-8 sm:pt-12 lg:px-12">
        <Btn size="sm" className="-ml-2 mb-6" onClick={onBack}><Icon name="back" />{backLabel}</Btn>
        <header className="flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <div className="text-micro tracking-wide text-ink-3">{eyebrow}</div>
            <h1 className="mt-2 break-words font-prose text-title font-medium text-ink sm:text-display">{title}</h1>
            {meta && <div className="mt-2 text-ui-sm text-ink-3">{meta}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
        {children}
      </div>
    </main>
  )
}

export function StudioSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section><div className="flex items-baseline gap-3 border-b border-line-soft pb-2"><h2 className="text-ui-sm font-medium text-ink-2">{title}</h2>{action && <div className="ml-auto">{action}</div>}</div>{children}</section>
}
