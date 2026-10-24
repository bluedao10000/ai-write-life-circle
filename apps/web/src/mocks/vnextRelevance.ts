import type { Chapter, Doc, Entry } from '../features/vnext/model'

export type Related = { entry: Entry; why: string }
export type RelatedGroups = { people: Related[]; rules: Related[]; facts: Related[]; threads: Related[]; more: number }

const LIMIT = 5

/**
 * "写这一章时需要记住什么" — every item carries a human-readable reason (its evidence for being here).
 * Threads appear only when the chapter falls inside the author's chosen payoff window, to avoid reminder fatigue.
 */
export function relatedFor(ch: Chapter | undefined, doc: Doc, entries: Entry[]): RelatedGroups {
  const empty = { people: [], rules: [], facts: [], threads: [], more: 0 }
  if (!ch) return empty
  const text = (doc[ch.id] ?? []).join('')
  const mentions = (e: Entry) => {
    const short = e.name.replace(/（.*?）/, '').split(' · ').pop()!
    return text.includes(short) || (e.id === 'p-lin' && text.includes('母亲'))
  }
  const people: Related[] = []
  const rules: Related[] = []
  const facts: Related[] = []
  const threads: Related[] = []
  for (const e of entries) {
    if (e.kind === 'person') {
      if (mentions(e)) people.push({ entry: e, why: e.id === 'p-lin' && !text.includes('林氏') ? '本章正文写到“母亲”' : `本章正文提到“${e.name.replace(/（.*?）/, '')}”` })
      else if (e.chapters.includes(ch.no)) people.push({ entry: e, why: `登记为${ch.no === e.firstSeen ? '首次出场' : '出场'}章节` })
    } else if (e.kind === 'rule' || e.kind === 'place') {
      if (mentions(e) || e.chapters.includes(ch.no)) rules.push({ entry: e, why: mentions(e) ? '本章场景所在' : `第 ${e.firstSeen} 章起生效` })
    } else if (e.kind === 'fact') {
      if (e.chapters.includes(ch.no)) facts.push({ entry: e, why: '本章回忆或引用了这件事' })
    } else if (e.kind === 'thread' && e.thread?.state === 'open') {
      const [a, b] = e.thread.window
      if (ch.no >= a && ch.no <= b) threads.push({ entry: e, why: `你定的回收时机：第 ${a}–${b} 章` })
    }
  }
  const all = [people, rules, facts, threads]
  const more = all.reduce((n, l) => n + Math.max(0, l.length - LIMIT), 0)
  return { people: people.slice(0, LIMIT), rules: rules.slice(0, LIMIT), facts: facts.slice(0, LIMIT), threads: threads.slice(0, LIMIT), more }
}

export const kindLabel: Record<Entry['kind'], string> = { person: '人物', rule: '规则', place: '地点', fact: '事实', thread: '伏笔', plot: '剧情' }
export const statusLabel: Record<Entry['status'], string> = { confirmed: '已确认', tentative: '暂定', open: '未回收' }
