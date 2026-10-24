import { useState } from "react";
import { Btn } from "../../components/vnext/ui";
import type { useStudioController } from "../vnext/useStudioController";
import ToolTimeline from "./ToolTimeline";
import {
  ConsentFacts,
  ConsentList,
  ConsentTitle,
} from "../../components/vnext/ConsentFacts";
const statusLabel = {
  accepted: "已接受",
  running: "思考中",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已取消",
  interrupted: "已中断",
};
export default function ThinkingPanel({
  studio,
}: {
  studio: ReturnType<typeof useStudioController>;
}) {
  const t = studio.thinking,
    [confirm, setConfirm] = useState(false),
    [notes, setNotes] = useState(false),
    [include, setInclude] = useState(false),
    [compact, setCompact] = useState(false),
    [localError, setLocalError] = useState("");
  const running = t.session?.status === "running";
  const send = async () => {
    setLocalError("");
    try {
      const text = t.draft.trim();
      if (!text) return;
      let selection;
      if (include) {
        const quote = studio.thinkingSeed || studio.selection;
        if (!quote) throw Error("请先选择原文。");
        const saved = await studio.workspace.prepareReview();
        selection = {
          chapterId: saved.chapterId,
          revisionId: saved.revisionId,
          contentHash: saved.contentHash,
          quote,
        };
      }
      t.send({ text, selection, compact });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "原文尚未保存。");
    }
  };
  return (
    <section
      aria-label="思考 Agent"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-prose text-lg">创作思考</h2>
        <Btn
          onClick={() => {
            t.select(null);
            setConfirm(true);
          }}
          disabled={t.busy}
        >
          新的思考
        </Btn>
        <Btn onClick={() => void t.reload()}>刷新</Btn>
      </div>
      <p className="text-ui-sm text-ink-3">
        讨论不会改写正文、正式设定或发布作品。引文证明原文存在，分析仍需作者判断。
      </p>
      <label className="text-ui-sm">
        历史会话
        <select
          aria-label="历史思考会话"
          className="ml-2 max-w-full rounded border p-2"
          value={t.selected ?? ""}
          onChange={(e) => {
            t.select(e.target.value || null);
            setConfirm(false);
          }}
          disabled={t.busy}
        >
          <option value="">选择会话</option>
          {t.sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      {t.selected && (
        <Btn
          className="self-start"
          disabled={t.busy}
          onClick={() => {
            if (window.confirm("删除这次私人讨论及其会话上下文？")) t.remove();
          }}
        >
          删除会话
        </Btn>
      )}
      {(confirm || !t.selected) && t.model ? (
        <div className="fade-up space-y-3 rounded-xl border border-line bg-surface p-5 text-ui-sm">
          <h3 className="text-ui-lg font-medium text-ink">
            <ConsentTitle>确认这次思考的数据范围</ConsentTitle>
          </h3>
          <ConsentFacts
            rows={[
              ["服务", t.model.provider],
              ["模型", t.model.model],
              ["端点", t.model.endpoint],
            ]}
          />
          <ConsentList
            title="会读取"
            kind="reads"
            items={[
              "本作品已保存章节与知识检索结果",
              "你的问题和本会话历史",
              "作者笔记（仅在下方勾选后）",
            ]}
          />
          <p className="text-ink-2">
            仅发送本作品已保存章节与知识检索结果、你的问题和本会话历史；私有笔记须额外选择。模型或范围变化后需新建会话确认。
          </p>
          <p className="text-micro text-ink-3">
            每次最多 {t.model.limits.maxTurnsPerRequest} 轮、
            {t.model.limits.maxToolCalls} 次工具调用，输入{" "}
            {t.model.limits.maxInputTokens} / 输出{" "}
            {t.model.limits.maxOutputTokens} Token；会话上限{" "}
            {t.model.limits.maxSessionTokens} Token，时限{" "}
            {Math.round(t.model.limits.maxDurationMs / 1000)}{" "}
            秒。用量缺失时保守计费；金额按服务商账单。
          </p>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-2 px-3.5 py-2.5 text-ink">
            <input
              type="checkbox"
              className="mt-0.5 accent-current"
              checked={notes}
              onChange={(e) => setNotes(e.target.checked)}
            />{" "}
            允许读取本作品的作者笔记
          </label>
          <Btn
            variant="primary"
            disabled={t.busy}
            onClick={() => {
              t.create(
                notes
                  ? ["chapters", "knowledge", "notes"]
                  : ["chapters", "knowledge"],
              );
              setConfirm(false);
            }}
          >
            同意以上范围并创建会话
          </Btn>
        </div>
      ) : null}
      {(t.error || localError) && (
        <div role="alert" className="rounded border border-line p-3 text-ui-sm">
          {localError || t.error} 输入已保留；可刷新或用同一输入重试。
        </div>
      )}
      {t.session ? (
        <>
          <div className="flex items-center gap-2 text-micro text-ink-3">
            <span>
              {t.session.model.model} · Token 预留累计 {t.session.usage.charged}
              {t.session.usage.incomplete ? "（含保守预留）" : ""}
            </span>
          </div>
          <div aria-live="polite" className="space-y-5">
            {t.session.messages.map((m) => (
              <article key={m.id} className="rounded border border-line p-4">
                <h3 className="mb-2 text-ui-sm text-ink-3">
                  {m.role === "user" ? "你" : "思考 Agent"} ·{" "}
                  {statusLabel[m.status]}
                </h3>
                <p className="whitespace-pre-wrap break-words font-prose">
                  {m.role === "user"
                    ? m.text
                    : m.text.replace(
                        /\[\[source:([^\]]+)\]\]/g,
                        (_all, id: string) => {
                          const index = m.sources.findIndex(
                            (src) => src.sourceId === id,
                          );
                          return index >= 0
                            ? `[原文 ${index + 1}]`
                            : m.status === "running"
                              ? "[引文待核验]"
                              : "[未核验引用]";
                        },
                      ) ||
                      (m.status === "accepted" || m.status === "running"
                        ? "正在思考…"
                        : m.status === "cancelled"
                          ? "本次思考已取消。"
                          : "未生成完整分析。")}
                </p>
                {m.errorCode && (
                  <p role="status" className="mt-2 text-ui-sm">
                    本次未完成：{m.errorCode}。可保留问题重新尝试。
                  </p>
                )}
                {m.errorCode && (
                  <Btn
                    disabled={t.busy || running}
                    onClick={() => {
                      const index = t.session!.messages.findIndex(
                        (v) => v.id === m.id,
                      );
                      const prior = t
                        .session!.messages.slice(0, index)
                        .reverse()
                        .find((v) => v.role === "user");
                      if (prior) t.setDraft(prior.text);
                    }}
                  >
                    用此问题重试
                  </Btn>
                )}
                {m.sources.map((src) => (
                  <details
                    key={src.sourceId}
                    className="mt-3 border-t border-line pt-2 text-ui-sm"
                  >
                    <summary>
                      {src.title} ·{" "}
                      {src.validity === "stale"
                        ? "旧版本引文"
                        : "原文位置已核验"}
                    </summary>
                    <p className="mt-2 text-micro text-ink-3">
                      Revision {src.revisionId} · {src.epistemic ?? "原文"}
                      （不代表推断成立）
                    </p>
                    <blockquote className="my-2 whitespace-pre-wrap border-l-2 pl-3">
                      {src.quote}
                    </blockquote>
                    <Btn
                      onClick={() => {
                        studio.workspace.switchChapter(src.chapterId);
                        studio.setView("write");
                      }}
                    >
                      打开章节
                    </Btn>
                  </details>
                ))}
              </article>
            ))}
          </div>
          {running && <ToolTimeline steps={t.steps} activeTool={t.tool} />}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="space-y-3"
          >
            <textarea
              aria-label="创作问题"
              placeholder="想和 Agent 讨论什么？"
              value={t.draft}
              onChange={(e) => t.setDraft(e.target.value)}
              maxLength={12000}
              className="w-full rounded border border-line bg-transparent p-3"
              rows={4}
            />
            <label className="block text-ui-sm">
              <input
                type="checkbox"
                checked={include}
                onChange={(e) => setInclude(e.target.checked)}
              />{" "}
              附上当前选中的原文（先安全保存）
            </label>
            <label className="block text-ui-sm">
              <input
                type="checkbox"
                checked={compact}
                onChange={(e) => setCompact(e.target.checked)}
              />{" "}
              先压缩此前讨论（计入本次模型预算）
            </label>
            <div className="flex gap-2">
              <Btn
                type="submit"
                disabled={t.busy || running || !t.draft.trim()}
              >
                发送问题
              </Btn>
              {running && (
                <Btn onClick={t.cancel} disabled={t.busy}>
                  取消思考
                </Btn>
              )}
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
