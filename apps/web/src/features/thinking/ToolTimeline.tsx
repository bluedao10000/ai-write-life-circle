import { Icon } from "../../components/vnext/ui";
import type { ToolStep } from "./toolActivity";

export const toolLabel: Record<string, string> = {
  search_knowledge: "检索作品知识",
  read_chapter: "核对章节原文",
  get_entity: "查阅人物与设定",
  find_related_chapters: "寻找相关章节",
  get_author_notes: "查阅作者笔记",
  get_timeline: "整理已有时间线",
  get_plot_threads: "查阅剧情与伏笔",
  load_analysis_skill: "加载分析方法",
  list_creative_assets: "查阅创作设定",
  get_creative_asset: "查阅一项设定",
  list_creative_proposals: "查看待确认候选",
  list_open_questions: "查看待决问题",
  get_writing_context: "整理本章设定",
  compare_plan_with_manuscript: "对照计划与正文",
  request_turn_organize: "安排整理本轮",
};
export const labelOf = (tool: string) => toolLabel[tool] ?? "作品资料";

/**
 * What the Thinking Agent is doing right now, from real tool events only.
 * Falls back to the single active tool when the page joined a running session
 * after earlier events were already consumed.
 */
export default function ToolTimeline({
  steps,
  activeTool,
}: {
  steps: ToolStep[];
  activeTool: string;
}) {
  if (steps.length === 0) {
    if (!activeTool) return null;
    return (
      <p role="status" className="text-ui-sm text-ink-3">
        正在查询：{labelOf(activeTool)}
      </p>
    );
  }
  return (
    <section
      aria-label="工具活动"
      aria-live="polite"
      className="rounded-lg border border-line p-3.5"
    >
      <p className="flex items-center gap-2 text-ui-sm text-ink">
        <span className="dot h-1.5 w-1.5 rounded-full bg-ai" aria-hidden />
        正在查阅作品资料
      </p>
      <ol className="mt-2 space-y-1.5 border-l border-line-soft pl-3">
        {steps.map((s) => (
          <li
            key={s.id}
            className={`flex items-center gap-2 text-ui-sm ${s.done ? "text-ink-2" : "text-ink"}`}
          >
            {s.done ? (
              <Icon name="check" className="text-ok" />
            ) : (
              <Icon name="tool" className="text-ai" />
            )}
            {labelOf(s.tool)}
            <span className="sr-only">{s.done ? "（已完成）" : "（进行中）"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
