import { useEffect, useMemo, useState } from 'react'
import type {
  MemoryAssertion,
  MemoryCorrection,
  MemoryEntity,
  MemorySource,
} from '@writer-agent/contracts'
import { Btn, Heading, Icon, IconBtn, TextInput } from '../../components/vnext/ui'
import { Disclosure, NatureTag, SourceCard, type Nature } from './kit'

export type DetailCorrection = {
  action: 'claim' | 'dispute' | 'separate'
  assertionId?: string
  entityId?: string
  chapterId?: string
  reason: string
}

const entityType: Record<MemoryEntity['type'], string> = {
  character: '人物',
  place: '地点',
  organization: '组织',
  world_rule: '世界规则',
  event: '事件',
  plot_line: '剧情候选',
  foreshadowing: '伏笔候选',
}

const entityStatus: Record<MemoryEntity['status'], string> = {
  observed: '正文中观察到',
  inferred: 'AI 推断',
  disputed: '作者指出理解有误',
  stale: '来源需要核对',
  deprecated: '已被后续知识替代',
}

const sections: { nature: Nature; title: string; hint: string }[] = [
  { nature: 'observation', title: '已知事实', hint: '正文直接写出的内容' },
  { nature: 'claim', title: '角色说法', hint: '角色说的或记得的，不一定客观成立' },
  { nature: 'inference', title: 'AI 推测', hint: '根据正文推断，需要你判断' },
]

function chapterLabel(chapterId: string, chapters: { id: string; title: string }[]) {
  return chapters.find((chapter) => chapter.id === chapterId)?.title || chapterId
}

function sourceFor(assertion: MemoryAssertion) {
  return assertion.sources.find((source) => source.validity === 'current') ?? assertion.sources[0]
}

function effectiveNature(
  assertion: MemoryAssertion,
  correction?: MemoryCorrection,
): MemoryAssertion['epistemic'] {
  return correction?.action === 'claim' ? 'claim' : assertion.epistemic
}

export default function KnowledgeDetail({
  entity,
  assertions,
  entities,
  corrections,
  chapters,
  busy,
  loadingFacts = false,
  factsError = false,
  onRetryFacts,
  onClose,
  onEntity,
  onReadSource,
  onChapter,
  onCorrect,
  onUndo,
}: {
  entity: MemoryEntity
  assertions: MemoryAssertion[]
  entities: MemoryEntity[]
  corrections: MemoryCorrection[]
  chapters: { id: string; title: string }[]
  busy: boolean
  loadingFacts?: boolean
  factsError?: boolean
  onRetryFacts?: () => void
  onClose: () => void
  onEntity: (id: string) => void
  onReadSource: (source: MemorySource) => void
  onChapter: (chapterId: string) => void
  onCorrect: (correction: DetailCorrection) => void
  onUndo: (correctionId: string) => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sources = useMemo(
    () => {
      const own = assertions.filter(
        (assertion) => assertion.entityId === entity.entityId,
      )
      const ids = new Set(
        own.flatMap((assertion) =>
          assertion.sources.map((source) => source.chapterId),
        ),
      )
      return [...ids]
        .sort()
        .slice(0, 6)
    },
    [assertions, entity.entityId],
  )
  const own = assertions.filter((assertion) => assertion.entityId === entity.entityId)
  const related = own
    .map((assertion) => assertion.targetEntityId)
    .filter((value): value is string => !!value && value !== entity.entityId)
  const relatedEntities = [...new Set(related)]
    .map((id) => entities.find((candidate) => candidate.entityId === id))
    .filter((value): value is MemoryEntity => !!value)
  const assertionCorrections = new Map(
    corrections
      .filter((correction) => correction.active && correction.assertionId)
      .map((correction) => [correction.assertionId!, correction]),
  )
  const counts = sections.map(({ nature }) => ({
    nature,
    count: own.filter(
      (assertion) =>
        effectiveNature(
          assertion,
          assertionCorrections.get(assertion.assertionId),
        ) === nature,
    ).length,
  }))

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-2 border-b border-line-soft px-5 py-3">
        <span className="text-ui-sm text-ink-3">
          {entityType[entity.type]} · 知识详情
        </span>
        <IconBtn icon="x" label="关闭详情" onClick={onClose} className="ml-auto" />
      </header>
      <div className="scroll min-h-0 flex-1 overflow-auto px-5 pt-5 pb-16">
        <div className="text-ui-sm text-ink-3">{entityStatus[entity.status]}</div>
        <Heading level={1} className="mt-1 break-words">
          {entity.name}
        </Heading>
        {entity.aliases.length > 0 && (
          <p className="mt-1 text-ui-sm text-ink-3">
            又称 {entity.aliases.join('、')}
          </p>
        )}
        {entity.identity && (
          <p className="mt-2 text-ui text-ink-2">{entity.identity}</p>
        )}

        {own.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {counts.map(
              ({ nature, count }) =>
                count > 0 && (
                  <span key={nature} className="inline-flex items-center gap-1 text-micro text-ink-3">
                    <NatureTag nature={nature} /> {count} 条
                  </span>
                ),
            )}
          </div>
        )}

        {loadingFacts && own.length === 0 && (
          <div className="mt-8 space-y-3" aria-busy="true" aria-label="正在读取知识详情">
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-3 w-11/12" />
            <div className="skeleton h-3 w-8/12" />
          </div>
        )}
        {factsError && own.length === 0 && (
          <div className="mt-8 rounded-lg border border-line-soft bg-surface-2 px-4 py-3">
            <p className="text-ui text-ink-2">详情暂时无法读取；名称与分类仍可查看。</p>
            {onRetryFacts && (
              <Btn variant="link" className="mt-1 text-ui-sm" onClick={onRetryFacts}>
                重新读取
              </Btn>
            )}
          </div>
        )}

        {sections.map(({ nature, title, hint }) => {
          const list = own.filter(
            (assertion) =>
              effectiveNature(
                assertion,
                assertionCorrections.get(assertion.assertionId),
              ) === nature,
          )
          if (!list.length) return null
          return (
            <section key={nature} className="mt-8">
              <div className="mb-3 flex flex-wrap items-baseline gap-2">
                <Heading level={3}>{title}</Heading>
                <span className="text-micro text-ink-3">{hint}</span>
              </div>
              <ul className="space-y-5">
                {list.map((assertion) => {
                  const correction = assertionCorrections.get(assertion.assertionId)
                  return (
                    <li key={assertion.assertionId}>
                      <AssertionItem
                        assertion={assertion}
                        nature={effectiveNature(assertion, correction)}
                        entity={entity}
                        correction={correction}
                        busy={busy}
                        chapters={chapters}
                        onReadSource={onReadSource}
                        onChapter={onChapter}
                        onCorrect={onCorrect}
                        onUndo={onUndo}
                      />
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}

        {!own.length && !loadingFacts && !factsError && (
          <p className="mt-8 rounded-lg bg-surface-2 px-4 py-3 text-ui text-ink-2">
            这条知识目前只有名称和分类，还没有可核验的正文陈述。
          </p>
        )}

        {relatedEntities.length > 0 && (
          <section className="mt-8">
            <Heading level={3} className="mb-3">
              关系与关联
            </Heading>
            <div className="flex flex-wrap gap-1.5">
              {relatedEntities.map((value) => (
                <Btn
                  key={value.entityId}
                  size="sm"
                  variant="outline"
                  onClick={() => onEntity(value.entityId)}
                >
                  {value.name}
                  <span className="text-micro text-ink-3">{entityType[value.type]}</span>
                </Btn>
              ))}
            </div>
          </section>
        )}

        {sources.length > 0 && (
          <section className="mt-8">
            <Heading level={3} className="mb-2">
              出现章节
            </Heading>
            <div className="flex flex-wrap gap-x-3">
              {sources.map((chapterId) => (
                <Btn
                  key={chapterId}
                  variant="link"
                  className="text-ui-sm"
                  onClick={() => onChapter(chapterId)}
                >
                  {chapterLabel(chapterId, chapters)}
                </Btn>
              ))}
            </div>
          </section>
        )}

        <div className="mt-10 border-t border-line-soft pt-5">
          <p className="flex gap-2 text-ui-sm text-ink-3">
            <Icon name="info" className="mt-0.5" />
            引用原文真实，不代表 AI 理解正确。知识不会自动成为作者确认的设定。
          </p>
        </div>
      </div>
    </div>
  )
}

function AssertionItem({
  assertion,
  nature,
  entity,
  correction,
  busy,
  chapters,
  onReadSource,
  onChapter,
  onCorrect,
  onUndo,
}: {
  assertion: MemoryAssertion
  nature: MemoryAssertion['epistemic']
  entity: MemoryEntity
  correction?: MemoryCorrection
  busy: boolean
  chapters: { id: string; title: string }[]
  onReadSource: (source: MemorySource) => void
  onChapter: (chapterId: string) => void
  onCorrect: (correction: DetailCorrection) => void
  onUndo: (correctionId: string) => void
}) {
  const [menu, setMenu] = useState(false)
  const [writing, setWriting] = useState(false)
  const [reason, setReason] = useState('')
  const source = sourceFor(assertion)
  const submit = (action: DetailCorrection['action'], text: string) => {
    onCorrect({
      action,
      assertionId: assertion.assertionId,
      entityId: entity.entityId,
      reason: text,
    })
    setMenu(false)
    setWriting(false)
    setReason('')
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <NatureTag nature={nature} speaker={assertion.speaker} />
        {correction && (
          <span className="inline-flex items-center gap-1 text-micro text-ok">
            <Icon name="check" className="h-3 w-3" />
            {correction.action === 'claim'
              ? '已改标为角色说法'
              : correction.action === 'separate'
                ? '已指出不是同一实体'
                : '已指出理解有误'}
            <Btn
              variant="link"
              className="text-micro"
              disabled={busy}
              onClick={() => onUndo(correction.correctionId)}
            >
              撤销
            </Btn>
          </span>
        )}
      </div>
      <p
        className={`mt-1.5 text-ui-lg ${
          correction?.action === 'dispute' || correction?.action === 'separate'
            ? 'text-ink-3 line-through decoration-ink-4'
            : 'text-ink'
        }`}
      >
        {assertion.text}
      </p>
      {(assertion.speaker || assertion.time) && (
        <p className="mt-1 text-ui-sm text-ink-3">
          {assertion.speaker ? `说话人：${assertion.speaker}` : ''}
          {assertion.speaker && assertion.time ? ' · ' : ''}
          {assertion.time ? `时间：${assertion.time}` : ''}
        </p>
      )}
      {source && (
        <div className="mt-2.5">
          <SourceCard
            source={source}
            chapterLabel={chapterLabel(source.chapterId, chapters)}
            onRead={onReadSource}
            onChapter={(value) => onChapter(value.chapterId)}
          />
        </div>
      )}
      {!correction && (
        <div className="mt-1.5">
          {!menu ? (
            <Btn variant="link" className="text-ui-sm text-ink-3" onClick={() => setMenu(true)}>
              <Icon name="edit" className="h-3 w-3" />
              纠正这一条
            </Btn>
          ) : (
            <div className="rounded-lg border border-line-soft bg-paper p-3">
              {!writing ? (
                <div className="flex flex-wrap gap-1.5">
                  {nature !== 'claim' && (
                    <Btn
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        submit('claim', '这是人物或叙述者的说法，不能作为客观事实。')
                      }}
                    >
                      这是角色说法
                    </Btn>
                  )}
                  <Btn size="sm" variant="outline" onClick={() => setWriting(true)}>
                    理解有误…
                  </Btn>
                  {entity.type === 'character' && (
                    <Btn
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        submit('separate', `这里说的不是${entity.name}。`)
                      }}
                    >
                      这里说的不是{entity.name}
                    </Btn>
                  )}
                  <Btn size="sm" onClick={() => setMenu(false)}>
                    取消
                  </Btn>
                </div>
              ) : (
                <>
                  <TextInput
                    label="说明哪里理解有误"
                    value={reason}
                    onChange={setReason}
                    placeholder="例如：这是角色的误解，不是客观事实"
                  />
                  <div className="mt-2 flex justify-end gap-1.5">
                    <Btn size="sm" onClick={() => setWriting(false)}>
                      返回
                    </Btn>
                    <Btn
                      size="sm"
                      variant="primary"
                      disabled={busy || !reason.trim()}
                      onClick={() => submit('dispute', reason.trim())}
                    >
                      提交纠正
                    </Btn>
                  </div>
                </>
              )}
              <p className="mt-2 text-micro text-ink-3">
                纠正只影响 AI 的整理，不会修改正文；撤销记录会保留在变更历史。
              </p>
            </div>
          )}
        </div>
      )}
      {correction && (
        <Disclosure label="查看你的纠正" className="mt-1">
          <p className="text-ui-sm text-ink-2">{correction.reason}</p>
        </Disclosure>
      )}
    </div>
  )
}

export { entityType }
