// 演示数据 · 原型专用。所有 Agent 产出为本地脚本模拟，未连接任何 LLM 或真实知识库。
import type { CanonChange, Chapter, Doc, Entry, Margin, Note, Session, StoryConflict } from '../features/vnext/model'

const named: Omit<Chapter, 'volume' | 'words'>[] = [
  { id: 'c1', no: 1, title: '灯下', setting: '永和二年冬 · 京城' },
  { id: 'c3', no: 3, title: '青瓷', setting: '永和二年冬 · 江宁旧宅（回忆）' },
  { id: 'c7', no: 7, title: '西直门', setting: '永和三年春 · 京城' },
  { id: 'c12', no: 12, title: '雨巷', setting: '永和三年秋 · 江宁柳巷' },
  { id: 'c13', no: 13, title: '樟木箱', setting: '永和三年秋 · 江宁柳巷' },
  { id: 'c14', no: 14, title: '', setting: '' },
]
const filler = ['夜渡', '旧账', '书信', '药铺', '城南', '霜降', '归雁', '河灯', '残局', '晚钟', '纸鸢', '空院', '北风', '归途', '旧友', '长街', '烛影', '断桥', '春汛', '槐树']
const volumeOf = (n: number) => (n <= 11 ? '第一卷 · 离京' : n <= 40 ? '第二卷 · 江宁' : n <= 70 ? '第三卷 · 旧案' : '第四卷 · 归处')

export function buildChapters(scale: 'long' | 'short'): Chapter[] {
  const max = scale === 'long' ? 100 : 14
  const out: Chapter[] = []
  for (let n = 1; n <= max; n++) {
    const hit = named.find((c) => c.no === n)
    if (hit) out.push({ ...hit, volume: volumeOf(n), words: 0 })
    else if (scale === 'long' || n < 14)
      out.push({ id: `c${n}`, no: n, title: filler[n % filler.length], volume: volumeOf(n), words: 2800 + ((n * 937) % 2400), placeholder: true })
  }
  return out
}

export const initialDoc: Doc = {
  c1: ['京城的冬夜来得早。沈砚伏在案前誊抄公文，灯芯结了花，他也懒得去剪。', '窗外有人踏雪走过，脚步声一下一下，像是在数他剩下的日子。'],
  c3: ['母亲总用那只缺了口的青瓷碗盛粥，从不肯换。沈砚小时候问过一次，她只说：“碗还能用。”', '那缺口在碗沿的左侧，喝粥时要侧过一点才不会割到嘴唇。全家人都学会了那个角度。'],
  c7: ['清明前三日，沈砚收拾了一只旧箱，自西直门出城。', '城外的柳树刚抽出新芽，细雨把官道泡得发软，车轮碾过去，留下两道很深的辙。'],
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

const S = (label: string, quote: string, extra: Partial<import('../features/vnext/model').Source> = {}) => ({ label, quote, state: 'ok' as const, ...extra })

export const initialEntries: Entry[] = [
  {
    id: 'p-shenyan', kind: 'person', name: '沈砚', status: 'confirmed', firstSeen: 1, lastConfirmed: 12, chapters: [1, 3, 7, 12, 13],
    summary: '京城小吏，二十八岁。性情克制，不善言辞。十年未回江宁。想回家，又害怕回家。',
    related: ['p-lin', 'pl-liuxiang', 'f-depart'],
    fields: [
      { label: '身份', value: '京城户部小吏', source: S('第 1 章 · 第 1 段', '伏在案前誊抄公文', { chapterId: 'c1', para: 0 }) },
      { label: '核心矛盾', value: '想回家，又害怕回家' },
      { label: '离京时间', value: '永和三年，清明前三日', source: S('第 7 章 · 第 1 段', '清明前三日，沈砚收拾了一只旧箱', { chapterId: 'c7', para: 0 }) },
    ],
    sources: [S('第 7 章 · 第 1 段', '清明前三日，沈砚收拾了一只旧箱，自西直门出城。', { chapterId: 'c7', para: 0 })],
    history: [{ at: '10 月 2 日', text: '确认“离京时间”为清明前三日', chapter: 7 }, { at: '9 月 21 日', text: '建立人物：沈砚', chapter: 1 }],
  },
  {
    id: 'p-lin', kind: 'person', name: '林氏（沈母）', status: 'confirmed', firstSeen: 3, lastConfirmed: 12, chapters: [3, 12, 13],
    summary: '寡居江宁柳巷。节俭，不表露情感，习惯以物代言。',
    related: ['p-shenyan', 'f-bowl'],
    fields: [
      { label: '与沈砚', value: '母子，十年未见' },
      { label: '标志物', value: '缺了口的青瓷碗', source: S('第 3 章 · 第 1 段', '缺了口的青瓷碗', { chapterId: 'c3', para: 0 }) },
      { label: '对沈砚归来的认知', value: '未确定' },
    ],
    sources: [S('第 12 章 · 第 4 段', '她没有抬头，只说：“回来了。”', { chapterId: 'c12', para: 3 })],
    history: [{ at: '9 月 28 日', text: '补充“以物代言”', chapter: 3 }],
  },
  {
    id: 'p-father', kind: 'person', name: '沈父', status: 'tentative', firstSeen: 3, chapters: [3], related: ['p-lin', 'f-letter'],
    summary: '已故。去世时间和原因尚未确定。',
    fields: [{ label: '去世时间', value: '未确定' }], sources: [], history: [],
  },
  {
    id: 'pl-liuxiang', kind: 'place', name: '江宁 · 柳巷', status: 'confirmed', firstSeen: 3, lastConfirmed: 12, chapters: [3, 12, 13], related: ['p-lin'],
    summary: '城南旧巷，多雨。青石板路，巷宽不足一丈。', fields: [{ label: '气候', value: '秋季多雨，雨声轻' }],
    sources: [S('第 12 章 · 第 1 段', '江宁的雨总是下得没有声音。', { chapterId: 'c12', para: 0 })], history: [],
  },
  {
    id: 'r-pass', kind: 'rule', name: '离京须持路引', status: 'confirmed', firstSeen: 7, lastConfirmed: 7, chapters: [7], related: ['p-shenyan'],
    summary: '官吏离京须由上官签发路引，城门查验。沈砚离京时持有路引。', fields: [], sources: [], history: [],
  },
  {
    id: 'f-depart', kind: 'fact', name: '沈砚离京', status: 'confirmed', firstSeen: 7, lastConfirmed: 7, chapters: [7, 12], related: ['p-shenyan'],
    summary: '永和三年三月，清明前三日，自西直门出城。',
    fields: [{ label: '时间', value: '永和三年 · 春' }, { label: '地点', value: '京城西直门' }],
    sources: [S('第 7 章 · 第 1 段', '清明前三日，沈砚收拾了一只旧箱，自西直门出城。', { chapterId: 'c7', para: 0 })],
    history: [{ at: '10 月 2 日', text: '确认离京季节为春', chapter: 7 }],
  },
  {
    id: 'f-bowl', kind: 'thread', name: '缺口青瓷碗', status: 'open', firstSeen: 3, chapters: [3], related: ['p-lin'],
    summary: '母亲固守的旧物。作者把它视为母亲与亡夫、与旧日的联系。尚未回收。',
    thread: { planted: 3, window: [12, 15], state: 'open' },
    fields: [{ label: '你定下的回收时机', value: '第 12–15 章之间' }],
    sources: [S('第 3 章 · 第 1 段', '母亲总用那只缺了口的青瓷碗盛粥，从不肯换。', { chapterId: 'c3', para: 0 })],
    history: [{ at: '9 月 28 日', text: '登记为伏笔，回收时机定为第 12–15 章', chapter: 3 }],
  },
  {
    id: 'f-lamp', kind: 'thread', name: '城门楼上的灯', status: 'open', firstSeen: 12, chapters: [12], related: ['p-shenyan'],
    summary: '沈砚离京时回望看到的灯。作者尚未决定它是否承担后文意义。',
    thread: { planted: 12, window: [38, 45], state: 'open' }, fields: [],
    sources: [S('第 12 章 · 第 2 段', '城门楼上的灯还没有灭', { chapterId: 'c12', para: 1 })], history: [],
  },
  {
    id: 'f-letter', kind: 'thread', name: '父亲未寄出的信', status: 'open', firstSeen: 1, chapters: [1], related: ['p-father'],
    summary: '第 1 章提及的一封信，内容未写出。',
    thread: { planted: 1, window: [20, 30], state: 'open' }, fields: [], sources: [{ label: '第 1 章', quote: '（原型中未包含该段原文）', state: 'missing' }], history: [],
  },
  {
    id: 'pt-return', kind: 'plot', name: '主线 · 归乡', status: 'confirmed', firstSeen: 1, chapters: [1, 7, 12, 13], related: ['p-shenyan', 'p-lin'],
    summary: '沈砚离京回到江宁，与母亲重新相处。第二卷的情感主线。', fields: [{ label: '所在卷', value: '第一卷末 — 第二卷' }], sources: [], history: [],
  },
]

// Long-form scale demo: extra people & threads with no real prose behind them.
const extraNames = ['周掌柜', '顾先生', '阿蘅', '陈主簿', '老马', '许三娘', '杜衡', '温氏', '小满', '韩知府', '苏二', '方姑', '刘捕头', '季先生', '宋姨', '何七', '冯老', '秦媒婆', '唐瞎子', '白鹭', '程夫人', '罗汉', '裴郎', '叶生', '褚大', '纪婆婆', '戚校尉', '邵公子', '甘棠', '殷十一']
export function buildExtras(): Entry[] {
  const people: Entry[] = extraNames.map((name, i) => {
    const first = 13 + ((i * 7) % 85)
    return { id: `x-p${i}`, kind: 'person', name, status: i % 4 === 0 ? 'tentative' : 'confirmed', firstSeen: first, lastConfirmed: Math.min(100, first + (i % 9) * 4), chapters: [first, first + 3], related: [], summary: '演示人物 · 用于长篇规模测试，无真实原文。', fields: [], sources: [], history: [], demo: true }
  })
  const threads: Entry[] = Array.from({ length: 24 }, (_, i) => {
    const planted = 4 + i * 4
    return { id: `x-f${i}`, kind: 'thread', name: `演示伏笔 ${i + 1}`, status: 'open', firstSeen: planted, chapters: [planted], related: [], summary: '演示伏笔 · 用于测试提醒疲劳。', thread: { planted, window: [planted + 6, planted + 16], state: i % 3 === 0 ? 'paid' : 'open' }, fields: [], sources: [], history: [], demo: true }
  })
  return [...people, ...threads]
}

export const initialMargins: Margin[] = [
  {
    id: 'm-season', chapterId: 'c12', para: 1, quote: '踏着初雪出城', tone: 'conflict', title: '离京的季节与第 7 章不一致',
    facts: [
      { label: '本章 · 第 2 段', quote: '他踏着初雪出城', chapterId: 'c12', para: 1, state: 'ok' },
      { label: '第 7 章 · 第 1 段', quote: '清明前三日，沈砚收拾了一只旧箱，自西直门出城。', chapterId: 'c7', para: 0, state: 'ok' },
      { label: '已确认事实 · 沈砚离京', quote: '永和三年三月，清明前三日', entryId: 'f-depart', state: 'ok' },
    ],
    inference: '两处叙述的季节不同。这可能是时间线错误，也可能是沈砚记忆的偏差——人在回想离别时，常把情绪写进天气。',
    question: '这里是沈砚记错了，还是需要重新核对时间线？', state: 'fresh', conflictId: 'k-season',
  },
  {
    id: 'm-bowl', chapterId: 'c12', para: 3, quote: '把一些旧物一件一件擦干净', tone: 'ai', title: '你为“青瓷碗”定的回收时机到了',
    facts: [
      { label: '第 3 章 · 第 1 段', quote: '母亲总用那只缺了口的青瓷碗盛粥，从不肯换。', chapterId: 'c3', para: 0, state: 'ok' },
      { label: '伏笔 · 缺口青瓷碗', quote: '你定下的回收时机：第 12–15 章', entryId: 'f-bowl', state: 'ok' },
    ],
    inference: '母亲在整理旧物，是一个可以呼应的位置；但在重逢的第一场就出现，也可能过早消耗它。',
    question: '你希望读者在哪一刻重新想起那只碗？', state: 'fresh', entryId: 'f-bowl',
  },
  {
    id: 'm-narrow', chapterId: 'c12', para: 2, quote: '巷子比记忆中窄了许多', tone: 'quiet', title: '与柳巷的设定可以互相印证',
    facts: [
      { label: '地点 · 江宁柳巷', quote: '巷宽不足一丈', entryId: 'pl-liuxiang', state: 'ok' },
      { label: '第 3 章（回忆）', quote: '（该段原文尚未建档）', state: 'missing' },
    ],
    inference: '“比记忆中窄”是人物感受，不与设定矛盾。第 3 章是否写过巷子宽窄，我没有找到原文依据。',
    question: '需要我在第 3 章定稿后再核对一次吗？', state: 'source-missing',
  },
]

export const initialConflicts: StoryConflict[] = [
  {
    id: 'k-season', title: '沈砚离京的季节',
    a: { label: '第 12 章 · 第 2 段（本章）', quote: '他记得自己离开那年，也是这样一个灰白的清晨。他踏着初雪出城，回头望时，城门楼上的灯还没有灭。', chapterId: 'c12', para: 1, state: 'ok' },
    b: { label: '第 7 章 · 第 1 段', quote: '清明前三日，沈砚收拾了一只旧箱，自西直门出城。城外的柳树刚抽出新芽。', chapterId: 'c7', para: 0, state: 'ok' },
    extra: { label: '已确认事实 · 沈砚离京', quote: '永和三年三月，清明前三日，自西直门出城。', entryId: 'f-depart', state: 'ok' },
    analysis: '第 7 章以叙述者口吻写春天离京，并已登记为确认事实；第 12 章是沈砚的回忆（“他记得”），写的是初雪。两者在字面上冲突。',
    readings: ['时间线错误：其中一处需要修改。', '记忆偏差：第 12 章写的是沈砚主观的记忆，可以成为人物刻画的一部分。', '信息不对称：沈砚其实离开过两次，第 7 章只写了其中一次。'],
    question: '你希望读者察觉到这个差异吗？',
  },
]

export const initialNotes: Note[] = [
  { id: 'n-next', text: '母亲递伞那一下，沈砚该不该接？先别让他开口。', at: Date.now() - 1000 * 60 * 60 * 20, origin: 'quick', chapterId: 'c12', para: 4, nextUp: true },
  { id: 'n-know', text: '林氏其实早就知道他要回来——她提前三天就开始擦那些旧物了。', at: Date.now() - 1000 * 60 * 60 * 26, origin: 'quick', chapterId: 'c12', para: 3, quote: '把一些旧物一件一件擦干净' },
  { id: 'n-old', text: '不回家是因为回家就要面对父亲已经不在。先不写破。', at: Date.now() - 1000 * 60 * 60 * 24 * 4, origin: 'thinking', sessionId: 's-past' },
  { id: 'n-fear', text: '沈砚怕的不是母亲老了，是母亲已经习惯了没有他。', at: Date.now() - 1000 * 60 * 60 * 72, origin: 'quick', chapterId: 'c12' },
]

export const canonTemplate = (noteId: string): CanonChange => ({
  id: `cc-${noteId}`, noteId, entryId: 'p-lin', field: '对沈砚归来的认知', current: '未确定', proposed: '事先知情：提前三天得知沈砚要回来，并开始整理旧物。',
  reason: '来自你的笔记：“林氏其实早就知道他要回来——她提前三天就开始擦那些旧物了。”',
  sources: [
    { label: '第 12 章 · 第 4 段', quote: '她正蹲在廊下，把一些旧物一件一件擦干净……她没有抬头，只说：“回来了。”', chapterId: 'c12', para: 3, state: 'ok' },
    { label: '你的笔记', quote: '她提前三天就开始擦那些旧物了。', state: 'ok' },
  ],
  chapters: [12, 13],
  impact: ['第 12 章“回来了”的语气将被读作“等到了”，而不是“意外”。', '第 13 章整理樟木箱的动机需要与“事先知情”一致。', '伏笔“缺口青瓷碗”的回收方式可能随之改变。'],
  status: 'draft',
})

export const initialSessions: Session[] = [
  {
    id: 's-past', topic: '沈砚为什么十年不回家', at: Date.now() - 1000 * 60 * 60 * 24 * 4,
    blocks: [
      { kind: 'idea', text: '我不想让他的不回家只是“忙”。' },
      { kind: 'understand', items: [{ text: '你希望“不回家”有一个沈砚自己都不愿承认的原因。', inferred: false }, { text: '你可能想让这个原因与父亲有关。', inferred: true }] },
      { kind: 'conclusion', text: '不回家是因为回家就要面对父亲已经不在。先不写破。', noteId: 'n-old' },
    ],
  },
]
