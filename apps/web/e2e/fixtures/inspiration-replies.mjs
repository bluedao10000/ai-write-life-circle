// Synthetic provider behaviour for the 灵感 browser stack (real Go + Pi, fake
// model HTTP). The long reply reuses the sample discussion from the Figma Make
// prototype (Writer Agent UI_UX Design/src/vnext/ideas.ts) so screenshots compare
// the same typography: headings, a numbered list, a quote and a bullet list.
// Never used by production code; real replies always come from the model.
export const GOOD = '张居正是讨论“人品”时很难绕开的人物：他让晚明的国库重新充实，却在父亲去世时没有回乡守制；他整顿吏治、推行考成法，身后却被抄家清算。同一个人，在不同的尺子下会得出截然相反的结论。\n\n## 三把不同的尺子\n\n1. **私德**：守信、孝道、俭朴。按这把尺子，“夺情”一事足以让他在当时的士大夫眼中失分。\n2. **公德**：是否对更多人负责。清丈田亩、推行一条鞭法，让许多普通人的负担变得更可预期。\n3. **代价由谁承担**：改革的阻力落在了谁身上？被他压下去的人，又会怎样记住他？\n\n> 言必信，行必果，硁硁然小人哉。——《论语·子路》\n\n连孔子也承认，死守个人信条未必就是最高的德行。真正难写的，是一个人明知自己会在某把尺子下失分，仍然做出选择的那一刻。\n\n## 放进你的平行宇宙\n\n- 如果在另一个宇宙里，他选择回乡守制，改革会不会就此中断？这一个选择，可以成为两个文明分岔的起点。\n- 也可以让同一个人在两个世界里分别被奉为圣人和罪人——读者会自己追问：哪一个才是他？\n\n这些只是讨论的材料，判断的标准由你来定。'
export const SHORT = '可以先抓住一个具体的选择：让人物在私德与公共责任冲突时，先背叛哪一个？这个问题本身就是故事的引擎。'
/** Questions containing this marker fail at the provider exactly once, then succeed. */
export const FAIL_ONCE = '【模拟模型故障】'
const lastUser = (body) => {
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
  return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
}
export function visualReply(body) {
  return /张居正|人品/.test(lastUser(body)) ? GOOD : SHORT
}
const failed = new Set()
export function failOnce(body) {
  const text = lastUser(body)
  if (!text.includes(FAIL_ONCE) || failed.has(text)) return undefined
  failed.add(text)
  return 500
}
