import { Btn } from "../../components/vnext/ui";
import type { useStudioController } from "../vnext/useStudioController";
import { thinkingError } from "./errors";
import ToolTimeline from "./ToolTimeline";

// Compact companion to the main Inspiration workspace; uses the same admission path.
export default function ThinkingPanel({studio}: {studio: ReturnType<typeof useStudioController>}) {
  const t = studio.thinking, running = t.session?.status === "running";
  return <section aria-label="灵感讨论" className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-5">
    <h2 className="font-prose text-lg">灵感</h2>
    <p className="text-ui-sm text-ink-3">讨论不会改写正文或正式设定。默认仅发送你的消息与本次讨论历史；作品资料范围可在灵感工作台设置。</p>
    <Btn disabled={t.busy || running} onClick={() => t.select(null)}>新话题</Btn>
    <select aria-label="历史思考会话" value={t.selected ?? ""} onChange={e => t.select(e.target.value || null)}>
      <option value="">新的讨论</option>{t.sessions.map(s => <option key={s.sessionId} value={s.sessionId}>{s.title}</option>)}
    </select>
    {t.error && <p role="alert">{t.error}</p>}
    <div aria-live="polite" className="space-y-4">{t.session?.messages.map(m => <article key={m.id}>
      <p className="text-micro text-ink-3">{m.role === "user" ? "你" : m.modelLabel ?? "创作伙伴"}</p>
      <p className="whitespace-pre-wrap break-words font-prose">{m.text || (running ? "正在回复…" : "")}</p>
      {m.errorCode && <p role="status">{thinkingError(m.errorCode)}</p>}
      {m.sources.map(src => <details key={src.sourceId}><summary>{src.title} · 原文依据</summary><blockquote>{src.quote}</blockquote><Btn onClick={() => {studio.workspace.switchChapter(src.chapterId);studio.setView("read")}}>打开章节</Btn></details>)}
    </article>)}</div>
    {running && <details><summary>查看执行详情</summary><ToolTimeline steps={t.steps} activeTool={t.tool}/></details>}
    <form onSubmit={e => {e.preventDefault();t.send({text: t.draft.trim()})}} className="space-y-3">
      <textarea disabled={t.busy} aria-label="创作问题" placeholder="从一个人物、一个世界规则或一个场景开始聊…" value={t.draft} onChange={e => t.setDraft(e.target.value)} maxLength={12000} rows={4} className="w-full rounded border border-line bg-transparent p-3"/>
      <select aria-label="选择对话模型" value={t.modelChoice} onChange={e => t.chooseModel(e.target.value)} disabled={t.busy || running}>{t.models.map(m => <option key={m.modelId} value={m.modelId} disabled={!m.enabled}>{m.displayName} · {m.hostedBy}</option>)}</select>
      <Btn type="submit" disabled={t.busy || running || !t.draft.trim() || !t.model}>发送问题</Btn>
      {running && <Btn onClick={t.cancel} disabled={t.busy}>停止生成</Btn>}
    </form>
  </section>;
}
