import type { ReactNode } from "react";
import type { MemoryPage } from "@writer-agent/contracts";
import { Dot } from "../../components/vnext/ui";

export type KnowledgeStatusPage = Pick<
  MemoryPage,
  | "settings"
  | "running"
  | "pending"
  | "failed"
  | "stale"
  | "available"
  | "workerStatus"
  | "budgetDay"
  | "budgetAttempts"
  | "budgetTokens"
  | "completed"
  | "chapterTotal"
>;

export type BackfillProgress = { done: number; total: number; percent: number };

/**
 * Real progress from the Go service: chapters whose latest job completed over
 * the chapters that can be analysed. Returns null when the API does not report
 * it (older server) so the UI never invents a number.
 */
export function backfillProgress(
  page: Pick<MemoryPage, "completed" | "chapterTotal">,
): BackfillProgress | null {
  const { completed, chapterTotal } = page;
  if (completed === undefined || chapterTotal === undefined || chapterTotal <= 0)
    return null;
  const done = Math.min(Math.max(completed, 0), chapterTotal);
  // floor: 100% is only shown when every chapter is actually done.
  return { done, total: chapterTotal, percent: Math.floor((done / chapterTotal) * 100) };
}

export function knowledgeStatusText(page: KnowledgeStatusPage): string {
  const base = !page.settings.enabled
    ? "尚未启用自动知识维护"
    : page.settings.paused
      ? "自动维护已暂停"
      : page.running
        ? "正在整理章节"
        : page.pending
          ? `有 ${page.pending} 章等待分析`
          : page.failed
            ? "知识更新失败，可重新分析"
            : "知识已同步";
  return base + (page.stale ? " · 部分来源已过期" : "");
}

type Tone = "quiet" | "ai" | "warn" | "danger" | "ok";
function tone(page: KnowledgeStatusPage): Tone {
  if (!page.settings.enabled) return "quiet";
  if (page.settings.paused) return "warn";
  if (page.running || page.pending) return "ai";
  if (page.failed) return "danger";
  return "ok";
}

export default function KnowledgeStatus({
  page,
  children,
}: {
  page: KnowledgeStatusPage;
  /** Action buttons. State changes stay in the parent. */
  children?: ReactNode;
}) {
  const progress = page.settings.enabled ? backfillProgress(page) : null;
  const showBar = progress !== null && progress.done < progress.total;
  return (
    <div className="my-6 rounded-lg border border-line bg-surface p-4 text-ui-sm">
      <p role="status" className="flex items-center gap-2 text-ink">
        <Dot tone={tone(page)} />
        <span>{knowledgeStatusText(page)}</span>
        {progress && (
          <span className="font-mono-num ml-auto text-micro text-ink-3">
            {progress.done} / {progress.total} 章
          </span>
        )}
      </p>
      {showBar && progress && (
        <progress
          className="meter mt-3"
          value={progress.done}
          max={progress.total}
          aria-label={`知识整理进度 ${progress.percent}%`}
        />
      )}
      {page.workerStatus && page.workerStatus !== "online" && (
        <p role="status" className="mt-2 text-ink-3">
          {page.workerStatus === "offline"
            ? "知识维护服务暂未在线，更新会延后；你可以继续写作和保存。"
            : "知识维护服务配置正在更新，暂未执行新分析。"}
        </p>
      )}
      {page.pending > 0 && (
        <p className="mt-1 text-ink-3">
          后台按章节顺序处理。账期 {page.budgetDay}（UTC）执行 {page.budgetAttempts}/
          {page.settings.dailyJobBudget} 次，Token 计费与预留{" "}
          {page.budgetTokens.toLocaleString()}/
          {page.settings.dailyTokenBudget.toLocaleString()}；
          任一额度用完后，北京时间 08:00 恢复。
        </p>
      )}
      {children && <div className="mt-3 flex flex-wrap gap-3">{children}</div>}
      {!page.available && (
        <p className="mt-2 text-ink-3">服务端模型尚未配置；已有知识仍可读取。</p>
      )}
    </div>
  );
}
