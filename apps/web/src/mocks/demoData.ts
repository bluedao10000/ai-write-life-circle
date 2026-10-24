// 演示数据 & 模拟 Agent。所有"AI"输出均为规则/模板生成，未连接任何 LLM。
import type { Chapter, ChallengeRound, Document, Evidence, KnowledgeEntry, Proposal } from '@writer-agent/contracts'

export const chapters: Chapter[] = [
  { id: 'c1', volume: '第一卷 · 离京', title: '第 1 章 灯下', meta: '永和二年 · 冬 · 京城' },
  { id: 'c3', volume: '第一卷 · 离京', title: '第 3 章 青瓷', meta: '永和二年 · 冬 · 江宁旧宅（回忆）' },
  { id: 'c7', volume: '第一卷 · 离京', title: '第 7 章 西直门', meta: '永和三年 · 春 · 京城' },
  { id: 'c12', volume: '第二卷 · 江宁', title: '第 12 章 雨巷', meta: '永和三年 · 秋 · 江宁柳巷' },
  { id: 'c13', volume: '第二卷 · 江宁', title: '第 13 章 樟木箱', meta: '永和三年 · 秋 · 江宁柳巷' },
  { id: 'c14', volume: '第二卷 · 江宁', title: '第 14 章 （草稿）', meta: '未设定' },
]

export const initialDoc: Document = {
  c1: [
    '京城的冬夜来得早。沈砚伏在案前誊抄公文，灯芯结了花，他也懒得去剪。',
    '窗外有人踏雪走过，脚步声一下一下，像是在数他剩下的日子。',
  ],
  c3: [
    '母亲总用那只缺了口的青瓷碗盛粥，从不肯换。沈砚小时候问过一次，她只说：“碗还能用。”',
    '那缺口在碗沿的左侧，喝粥时要侧过一点才不会割到嘴唇。全家人都学会了那个角度。',
  ],
  c7: [
    '清明前三日，沈砚收拾了一只旧箱，自西直门出城。',
    '城外的柳树刚抽出新芽，细雨把官道泡得发软，车轮碾过去，留下两道很深的辙。',
  ],
  c12: [
    '江宁的雨总是下得没有声音。沈砚立在巷口，看檐下的水一线一线地垂落，像是谁把旧年的光阴拆散了，又一根一根挂回原处。',
    '他记得自己离开那年，也是这样一个灰白的清晨。他踏着初雪出城，回头望时，城门楼上的灯还没有灭，像一只不肯合上的眼睛。',
    '巷子比记忆中窄了许多。青石板被雨水洗得发亮，缝隙里生出细密的苔，踩上去有一点软，仿佛整条巷子都在轻轻地喘气。',
    '母亲的院门虚掩着。他推门进去，看见她正蹲在廊下，把一些旧物一件一件擦干净，再放进樟木箱里。她没有抬头，只说：“回来了。”',
    '那一声“回来了”，轻得像是他只是出门买了一趟酱油。沈砚站在雨里，忽然不知道该把手里的伞收起，还是继续撑着。',
  ],
  c13: ['樟木箱的气味很重，一打开，整间屋子都像回到了十年前。'],
  c14: [''],
}

export const knowledge: KnowledgeEntry[] = [
  { id: 'tl-3', kind: '时间线', title: '永和三年', body: '三月 · 沈砚离京赴江宁（第 7 章）\n九月 · 沈砚抵江宁柳巷（第 12 章）', fields: [['季节', '春 → 秋'], ['关联章节', '第 7、12 章']] },
  { id: 'ch-sy', kind: '人物档案', title: '沈砚', body: '主角。京城小吏，性情克制，不善言辞。十年未归江宁。', fields: [['年龄', '二十八'], ['核心矛盾', '想回家，又害怕回家']] },
  { id: 'ch-ls', kind: '人物档案', title: '沈母 · 林氏', body: '寡居江宁柳巷。节俭，不表露情感，以物代言。', fields: [['标志物', '缺口青瓷碗'], ['与主角', '母子，十年未见']] },
  { id: 'fs-07', kind: '伏笔', title: 'F-07 缺口青瓷碗', body: '第 3 章埋设。象征母亲对旧日与亡夫的固守。尚未回收。', fields: [['埋设', '第 3 章 ¶1'], ['状态', '未回收']] },
  { id: 'wd-jn', kind: '世界观', title: '江宁 · 柳巷', body: '城南旧巷，多雨。青石板路，巷宽不足一丈。' },
]

export const uid = () => Math.random().toString(36).slice(2, 9)

/** 模拟连续性审查：基于规则匹配当前正文，结果可复现、可被作者修改正文所"解决"。 */
export function mockReview(chapterId: string, doc: Document, seq: number): Proposal[] {
  const paras = doc[chapterId] ?? []
  const found: Proposal[] = []
  const now = Date.now()
  const pid = (n: number) => `P-${chapterId.slice(1).padStart(3, '0')}-${String(seq + n).padStart(2, '0')}`
  const ch = chapters.find((c) => c.id === chapterId)!
  const isAutumnOrLater = ch.meta.includes('秋')

  paras.forEach((p, i) => {
    if (p.includes('初雪') && (chapterId === 'c12' || isAutumnOrLater)) {
      found.push({
        id: pid(1), ruleKey: `${chapterId}:depart-season`, kind: 'fact', origin: '审查',
        title: '时间线冲突：沈砚离京的季节', chapterId, anchor: { paraIndex: i, quote: '初雪' },
        analysis: {
          facts: ['本段写沈砚“踏着初雪出城”。', '第 7 章记载他“清明前三日”离京。', '时间线条目「永和三年」登记为三月离京。'],
          inferences: ['“初雪”可能是回忆中的情绪化记忆，而非事实错误——需作者确认。'],
          suggestion: '统一离京季节，或明确这是沈砚记忆的偏差。',
        },
        evidence: [
          { type: 'chapter', chapterId: 'c7', paraIndex: 0, quote: '清明前三日', label: '第 7 章 · ¶1' },
          { type: 'knowledge', entryId: 'tl-3', label: '时间线 · 永和三年', quote: '三月 · 沈砚离京赴江宁' },
        ],
        impact: ['第 12 章 ¶2', '第 7 章 ¶1–2', '时间线 · 永和三年'],
        options: [
          { id: 'a', label: '修改第 12 章的季节描写', detail: '由你改写本段，使离京时节与清明相符。' },
          { id: 'b', label: '修改第 7 章与时间线', detail: '离京改为冬季，需同步更新时间线条目。' },
          { id: 'c', label: '保留为记忆偏差', detail: '在后文让沈砚意识到自己记错了，转化为人物刻画。' },
        ],
        status: 'pending', createdAt: now, updatedAt: now,
      })
    }
    if (p.includes('旧物') && !paras.join('').includes('青瓷')) {
      found.push({
        id: pid(2), ruleKey: `${chapterId}:fs-07`, kind: 'suggestion', origin: '审查',
        title: '伏笔回收机会：缺口青瓷碗', chapterId, anchor: { paraIndex: i, quote: '旧物' },
        analysis: {
          facts: ['伏笔 F-07 于第 3 章埋设，至今未回收。', '本段母亲正在整理旧物。'],
          inferences: ['此处是自然的呼应时机，但也可能过早消耗这个伏笔。'],
          suggestion: '考虑让青瓷碗在此出现，或刻意让它缺席以制造悬念。',
        },
        evidence: [
          { type: 'chapter', chapterId: 'c3', paraIndex: 0, quote: '缺了口的青瓷碗', label: '第 3 章 · ¶1' },
          { type: 'knowledge', entryId: 'fs-07', label: '伏笔 · F-07', quote: '尚未回收' },
        ],
        impact: ['第 12 章 ¶4', '伏笔 F-07'],
        options: [
          { id: 'a', label: '在本章回收', detail: '青瓷碗出现在樟木箱旁。' },
          { id: 'b', label: '刻意缺席', detail: '沈砚注意到碗不见了，延后至第 13 章揭示。' },
        ],
        status: 'pending', createdAt: now, updatedAt: now,
      })
    }
  })

  if (paras.join('').includes('雨')) {
    found.push({
      id: pid(3), ruleKey: `${chapterId}:research-rain`, kind: 'research', origin: '审查',
      title: '研究参考：以物写人的归乡书写', chapterId,
      analysis: {
        facts: ['归有光《项脊轩志》以庭中枇杷树收尾，不直写悲伤。'],
        inferences: ['本章“雨”与“伞”的处理与此传统相近。'],
        suggestion: '仅作参考，不构成作品事实，也不涉及正文修改。',
      },
      evidence: [{ type: 'unavailable', label: '外部文献 · 归有光《项脊轩志》', quote: '庭有枇杷树，吾妻死之年所手植也，今已亭亭如盖矣。' }],
      impact: ['待整理参考'], options: [], status: 'pending', createdAt: now, updatedAt: now,
    })
  }
  return found
}

export function mockChallenge(intent: string, prev: ChallengeRound[]): ChallengeRound {
  const id = uid()
  if (prev.length === 0 && intent.includes('感知') && intent.includes('欲望')) {
    return {
      id, intent,
      understanding: [
        { text: '你认为：精神体的感知能力与欲望强度呈反比。', speculative: false },
        { text: '你可能想借此表达“看透即放下”的东方式超脱。', speculative: true },
        { text: '这条规律或将作为世界观中的普遍法则，而非个别人物特质。', speculative: true },
      ],
      critique: [
        { tag: '逻辑漏洞', text: '如果精神体能够感知更多可能性，为什么这不会激发更强的探索欲？“知道更多”通常扩大而非缩小欲望的对象。' },
        { tag: '反例', text: '人类中感知敏锐者（诗人、学者）往往欲望更炽烈，只是方向不同。' },
        { tag: '不同立场', text: '低欲望究竟是生命本性，还是社会规则长期约束的结果？若是后者，这就是一个关于压抑的故事，而非超脱。' },
        { tag: '主题距离', text: '若所有高感知者都低欲望，故事将缺少由欲望驱动的冲突，主题可能停留在陈述层面。' },
      ],
      questions: ['有没有一个高感知、却欲望极强的例外？他/她在社会中处于什么位置？', '“欲望低”是精神体自己的描述，还是外部观察者的判断？', '如果这条规律被打破，谁会最害怕？'],
    }
  }
  const short = intent.length > 24 ? intent.slice(0, 24) + '…' : intent
  return {
    id, intent,
    understanding: [
      { text: `你的观点是：「${short}」`, speculative: false },
      { text: prev.length ? '你在回应上一轮的质疑，尝试收窄原有论断的适用范围。' : '你希望它成为推动情节的内在逻辑。', speculative: true },
    ],
    critique: [
      { tag: '不同立场', text: '站在故事中受此规则影响最深的人物视角，他会如何反驳这一观点？' },
      { tag: '主题距离', text: '这一观点目前是否已有情节承载？若只存在于叙述者的议论中，读者可能无法感受到。' },
    ],
    questions: ['这个观点在哪一章第一次被读者“看见”而不是“被告知”？', '如果把它反过来写，故事会失去什么？'],
  }
}

export function mockChat(text: string, quote?: string): { text: string; cites?: Evidence[] } {
  if (text.startsWith('/inspire'))
    return { text: '几个开放式问题，供你思考（不提供正文）：\n· 沈砚此刻最怕母亲问什么？\n· 雨停之后，这条巷子对他还意味着什么？\n· 母亲擦拭旧物的顺序，是否暗示了她这十年的心事？' }
  if (quote)
    return {
      text: `关于你引用的这段：其中的克制更像长久等待后的自我保护（推测）。我想提出一个反对意见：若读者没有记住第 3 章的母亲形象，这里容易被读成冷漠。是否需要额外提示，由你决定。`,
      cites: [{ type: 'chapter', chapterId: 'c3', paraIndex: 0, quote: '缺了口的青瓷碗', label: '第 3 章 · ¶1' }, { type: 'knowledge', entryId: 'ch-ls', label: '人物档案 · 林氏', quote: '以物代言' }],
    }
  return {
    text: '我目前只能基于已建档的资料回答。根据人物档案，沈砚“想回家，又害怕回家”——你的问题是否与这层矛盾有关？可以选中正文段落后再问，我会给出更具体的分析。',
    cites: [{ type: 'knowledge', entryId: 'ch-sy', label: '人物档案 · 沈砚', quote: '想回家，又害怕回家' }],
  }
}
