import { useEffect, useState } from 'react'
import type { CreativeAsset, CreativeLink } from '@writer-agent/contracts'
import { Btn, Heading } from '../../components/vnext/ui'
import { knowledgeApi } from '../../services/api/knowledgeApi'

type Entity = { entityId: string; name: string; type: string; aliases: string[] }
type Assertion = { assertionId: string; entityId: string; text: string; epistemic: string }

const epistemicLabels: Record<string, string> = { observation: '正文观察', claim: '角色说法', inference: 'AI 推测' }

/**
 * Shows AI manuscript observations next to an author asset. They stay labelled
 * as observations; linking records a relation and never merges either side.
 */
export default function ManuscriptMatches({
  bookId,
  asset,
  links,
  busy,
  onLink,
}: {
  bookId: string
  asset: CreativeAsset
  links: CreativeLink[]
  busy: boolean
  onLink: (entityId: string) => void
}) {
  const [entities, setEntities] = useState<Entity[] | null>(null)
  const [assertions, setAssertions] = useState<Assertion[]>([])
  useEffect(() => {
    const abort = new AbortController()
    knowledgeApi
      .query(bookId, new URLSearchParams({ name: asset.name, limit: '5' }), abort.signal)
      .then((page) => {
        setEntities(page.entities as Entity[])
        setAssertions((page.assertions as Assertion[]).slice(0, 6))
      })
      .catch(() => setEntities([]))
    return () => abort.abort()
  }, [bookId, asset.name])
  const linked = new Set(links.filter((l) => l.to.type === 'knowledge_entity').map((l) => l.to.id))
  if (!entities || entities.length === 0)
    return (
      <section>
        <Heading level={3} className="mb-2">正文中的相关观察</Heading>
        <p className="text-ui-sm text-ink-3">{entities ? '已保存正文中还没有与此同名的 AI 观察。' : '正在查找…'}</p>
      </section>
    )
  return (
    <section>
      <Heading level={3} className="mb-1">正文中的相关观察</Heading>
      <p className="mb-2 text-micro text-ink-3">以下来自 AI 对已保存正文的整理，不是你的设定。同名不一定是同一人物，关联由你决定。</p>
      <ul className="space-y-2">
        {entities.map((e) => (
          <li key={e.entityId} className="rounded-md border border-dashed border-line p-2.5 text-ui-sm">
            <div className="flex items-center gap-2">
              <span className="text-ink">{e.name}</span>
              <span className="text-micro text-ink-3">正文观察</span>
              {linked.has(e.entityId) ? (
                <span className="ml-auto text-micro text-ok">已关联</span>
              ) : (
                <Btn size="sm" className="ml-auto" disabled={busy} onClick={() => onLink(e.entityId)}>
                  关联到此设定
                </Btn>
              )}
            </div>
            <ul className="mt-1 space-y-0.5 text-ink-2">
              {assertions
                .filter((a) => a.entityId === e.entityId)
                .map((a) => (
                  <li key={a.assertionId}>
                    <span className="mr-1 text-micro text-ink-3">{epistemicLabels[a.epistemic] ?? a.epistemic}</span>
                    {a.text}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
