// 模拟 Agent（原型）。规则与模板生成，结果可复现；不调用 LLM，不改动正文与已确认设定。
import type { ThinkBlock } from '../features/vnext/model'

type U = Extract<ThinkBlock, { kind: 'understand' }>
type C = Extract<ThinkBlock, { kind: 'challenge' }>
type R = Extract<ThinkBlock, { kind: 'research' }>

const clip = (s: string, n = 28) => (s.length > n ? s.slice(0, n) + '…' : s)

export function understand(idea: string, quote?: string): U {
  if (/母亲|林氏|冷淡|克制/.test(idea))
    return {
      kind: 'understand',
      items: [
        { text: '你希望读者感到母亲的冷淡背后有一种长期的等待，而不是不爱。', inferred: false },
        { text: '你可能想让这种情感一直不被说破，只通过动作和物件被读者察觉。', inferred: true },
        { text: '你也许担心：写得太克制，读者会直接读成冷漠。', inferred: true },
      ],
    }
  return {
    kind: 'understand',
    items: [
      { text: `你想表达的是：“${clip(idea)}”`, inferred: false },
      ...(quote ? [{ text: `并且你希望这一点落在这段原文上：“${clip(quote, 20)}”`, inferred: false }] : []),
      { text: '你可能希望它通过人物的行为被看见，而不是由叙述者说出来。', inferred: true },
    ],
  }
}

export function revise(prev: U, correction: string): U {
  return {
    kind: 'understand',
    revised: true,
    items: [
      { text: `按你的修正：“${clip(correction, 36)}”`, inferred: false },
      ...prev.items.filter((i) => !i.inferred).slice(0, 1),
      { text: '那么关键不在于让读者“看出爱”，而在于让读者和沈砚一样，迟一步才明白。', inferred: true },
    ],
  }
}

export function challenge(idea: string): C {
  const mother = /母亲|林氏|冷淡|克制|等待/.test(idea)
  return {
    kind: 'challenge',
    items: mother
      ? [
          { tag: '读者视角', text: '如果读者没有记住第 3 章的母亲，“回来了”这一句很可能只被读成冷淡。克制要以读者已经知道的东西为前提。' },
          { tag: '反例', text: '一个真正在等待的人，往往会在细节上失控：比如多准备了一副碗筷。完全不失控，反而像不在乎。' },
          { tag: '人物合理性', text: '十年没有来信催促，和“一直在等”之间，需要一个让读者信服的理由。' },
          { tag: '主题距离', text: '如果母亲的等待从头到尾都没有代价，这个主题会停留在“温情”，而碰不到“误解”。' },
        ]
      : [
          { tag: '反例', text: '站在受这件事影响最深的人物那里，他会怎样反驳？' },
          { tag: '主题距离', text: '这一点目前有没有情节承载？如果只存在于叙述里，读者可能感受不到。' },
        ],
    questions: mother ? ['母亲身上，有没有一处“没藏住”的细节？', '沈砚是在哪一刻、因为什么才明白的？'] : ['读者会在哪一章第一次“看见”它，而不是“被告知”？'],
  }
}

export function research(): R {
  return {
    kind: 'research',
    items: [
      { work: '归有光《项脊轩志》', mechanism: '结尾不写悲伤，只写一棵树长大了。情感被时间和物件承载，读者自己完成最后一步。', cite: '庭有枇杷树，吾妻死之年所手植也，今已亭亭如盖矣。', verified: false },
      { work: '朱自清《背影》', mechanism: '父爱通过一个笨拙的动作（越过月台去买橘子）呈现；叙述者当时不懂，多年后才懂。“迟到的理解”本身就是结构。', verified: false },
      { work: '是枝裕和《步履不停》（电影）', mechanism: '母亲把执念藏在家常仪式里，家人在饭桌上互相回避；观众比人物更早察觉。', verified: false },
    ],
  }
}
