import { canonicalJSON } from "../runtime/fingerprint.js";
import { Type } from "typebox";
import { z } from "zod";
import { readFileSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  thinkingSourceSchema,
  thinkingGrantSchema,
  recordStoryChangesInputSchema,
  discussionFocusInputSchema,
  type ThinkingSource,
  type ThinkingMessage,
} from "@writer-agent/contracts";
import type { Config } from "../config.js";
export const storyNames = [
  "search_knowledge",
  "read_chapter",
  "get_entity",
  "find_related_chapters",
  "get_author_notes",
  "get_timeline",
  "get_plot_threads",
  "list_creative_assets",
  "get_creative_asset",
  "list_creative_proposals",
  "list_open_questions",
  "get_writing_context",
  "compare_plan_with_manuscript",
  "request_turn_organize",
  "get_discussion_source",
  "record_story_changes",
  "offer_story_changes",
  "update_discussion_focus",
] as const;
const mutationNames = new Set(["record_story_changes", "offer_story_changes", "update_discussion_focus"]);
const storyChangeNames = new Set(["record_story_changes", "offer_story_changes"]);
export type StoryWrites = Record<string, { arguments: unknown; tool?: string; result?: string }>;
export type StoryExecution = {messageId: string; runId: string; dialogueRecording: boolean; writes: StoryWrites; persist: () => void; onStoryRecording?: (state: NonNullable<ThinkingMessage["storyRecording"]>) => void};
const creativeNames = new Set<string>([
  "list_creative_assets",
  "get_creative_asset",
  "list_creative_proposals",
  "list_open_questions",
  "get_writing_context",
  "compare_plan_with_manuscript",
  "request_turn_organize",
  "get_discussion_source",
  "record_story_changes",
  "offer_story_changes",
  "update_discussion_focus",
]);
const descriptions: Partial<Record<(typeof storyNames)[number], string>> = {
  list_creative_assets: "Author's creative assets (optional kind, query). accepted=confirmed, draft=draft; plans are intentions.",
  get_creative_asset: "One creative asset by assetId, with links.",
  list_creative_proposals: "UNCONFIRMED AI proposals awaiting review; never canon.",
  list_open_questions: "Author's undecided questions.",
  get_writing_context: "Confirmed plans, characters and rules for chapterId.",
  compare_plan_with_manuscript: "Plans for chapterId beside AI manuscript observations; differences are questions, not errors.",
  request_turn_organize: "Queue organizing this turn into proposals for author review. Only when the author asks.",
  get_discussion_source: "Read an original message by sessionId and messageId from this author's book. Author words, assistant proposals and character viewpoints have different authority.",
  record_story_changes: "Record one complete batch for this author turn. decide=explicit author decision; explore=unconfirmed alternative; reject=discarded idea; defer=question parked until revisited. Cite exact original messages including current author message. Use asset baseVersion for edits. Never writes manuscript. A receipt confirms the actual result.",
  offer_story_changes: "Offer one complete change batch for this author turn for manual recording. Does not change story settings. Use decide/explore/reject/defer and cite exact original messages including the current author. The returned offered receipt means awaiting author action, never saved.",
  update_discussion_focus: "Remember this discussion's current goal, related assetIds, questionIds and optional next step. One update per author turn; use focus baseVersion when present. Does not confirm story facts.",
};
export async function authorize(
  config: Config,
  capability: string,
  signal?: AbortSignal,
) {
  const res = await fetch(config.storyOrigin + "/internal/v1/agent/authorize", {
    method: "POST",
    headers: { Authorization: "Bearer " + capability },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    redirect: "error",
  }).catch(() => {throw Error("SESSION_INTERRUPTED")});
  if (!res.ok) throw Error([401,403,410].includes(res.status) ? "AUTHORIZATION_REVOKED" : "SESSION_INTERRUPTED");
  return thinkingGrantSchema.parse(await res.json());
}
export function tools(
  config: Config,
  id: string,
  capability: string,
  signal: AbortSignal,
  onSources: (v: ThinkingSource[]) => void,
  /** Returns false when this reply's tool budget is spent; the call is then not executed. */
  onCall: () => boolean,
  scopes: readonly string[] = [],
  execution?: StoryExecution,
): ToolDefinition[] {
  const seen = new Set<string>();
  const uncertain = new Set<string>();
  const id128 = Type.String({ maxLength: 128 });
  const narrow: Record<string, ReturnType<typeof Type.Object>> = {
    list_creative_assets: Type.Object({ query: Type.Optional(Type.String({ maxLength: 256 })), kind: Type.Optional(Type.String({ maxLength: 40 })) }, { additionalProperties: false }),
    get_creative_asset: Type.Object({ assetId: id128 }, { additionalProperties: false }),
    get_writing_context: Type.Object({ chapterId: id128 }, { additionalProperties: false }),
    compare_plan_with_manuscript: Type.Object({ chapterId: id128 }, { additionalProperties: false }),
    get_discussion_source: Type.Object({sessionId: id128, messageId: id128}, {additionalProperties: false}),
  };
  const mutations = {
    record_story_changes: Type.Unsafe(z.toJSONSchema(recordStoryChangesInputSchema, {io:"input"})),
    offer_story_changes: Type.Unsafe(z.toJSONSchema(recordStoryChangesInputSchema, {io:"input"})),
    update_discussion_focus: Type.Unsafe(z.toJSONSchema(discussionFocusInputSchema, {io:"input"})),
  };
  const empty = Type.Object({}, { additionalProperties: false });
  const parameters = Type.Object(
    {
      quote: Type.Optional(Type.String({ maxLength: 4000 })),
      query: Type.Optional(Type.String({ maxLength: 256 })),
      chapterId: Type.Optional(Type.String({ maxLength: 128 })),
      revisionId: Type.Optional(Type.String({ maxLength: 128 })),
      entityId: Type.Optional(Type.String({ maxLength: 128 })),
      startUTF16: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  );
  const granted = storyNames.filter((name) => (!mutationNames.has(name) || (execution && (name === "update_discussion_focus" || (name === "record_story_changes" ? execution.dialogueRecording : !execution.dialogueRecording)))) && scopes.includes(creativeNames.has(name) ? "creative" : name === "get_author_notes" ? "notes" : ["read_chapter", "find_related_chapters"].includes(name) ? "chapters" : "knowledge"));
  return [
    ...granted.map(
      (name) =>
        ({
          name,
          label: name,
          description:
            descriptions[name] ??
            `Read-only author-scoped Story Tool: ${name}. No paths, bookId or authorId accepted. Chapter windows are limited; follow truncated/totalUTF16 to retrieve more.`,
          parameters: name in mutations ? mutations[name as keyof typeof mutations] : creativeNames.has(name) ? (narrow[name] ?? empty) : parameters,
          async execute(_id, args) {
            if (!onCall()) return budgetSpent();
            const mutation = mutationNames.has(name);
            const storyChange = storyChangeNames.has(name);
            // Both automatic and offered batches share the same logical-message receipt.
            const writeKey = storyChange ? "record_story_changes" : name;
            const changeCount = storyChange ? (args as {changes:unknown[]}).changes.length : 0;
            const report = (status: NonNullable<ThinkingMessage["storyRecording"]>["status"], code?:string, changeId?:string, count=changeCount) => {
              if (storyChange) execution?.onStoryRecording?.({status,changeCount:count,...(code?{code}:{}),...(changeId?{changeId}:{})});
            };
            const reportReceipt = (text:string) => {
              if (!storyChange) return;
              const receipt = JSON.parse(text) as {status:"applied"|"offered"|"undone";changeId:string;changes?:unknown[]};
              report(receipt.status,undefined,receipt.changeId,receipt.changes?.length ?? changeCount);
            };
            const fingerprint = canonicalJSON([name, args]);
            if (mutation && execution) {
              const previous = execution.writes[writeKey];
              if (previous?.result) {reportReceipt(previous.result);execution.persist();return toolText(previous.result, {alreadyRecorded: true});}
              if (previous && (previous.tool ?? writeKey) !== name) return feedback("PENDING_STORY_CHANGE", "The unresolved request used a different recording mode. Do not change the original operation; re-read its outcome before offering or recording a new batch.");
              if (previous && canonicalJSON(previous.arguments) !== canonicalJSON(args)) return feedback("PENDING_STORY_CHANGE", "The previous request has no confirmed outcome. Retry only its exact arguments; do not submit a different batch.", {arguments: previous.arguments});
              if (uncertain.has(name)) return feedback("OUTCOME_UNKNOWN", "The save outcome is unknown. Do not claim it was saved or issue another batch this reply; the original request is retained for recovery.");
              execution.writes[writeKey] = {arguments: args,tool:name};
              report("saving");
              execution.persist();
            } else if (seen.has(fingerprint)) return {content: [{type: "text" as const, text: "This exact lookup was already attempted. Do not repeat it. Answer using available information and explain any gaps."}], details: {duplicate: true}};
            seen.add(fingerprint);
            const deadline = AbortSignal.timeout(5000);
            let res: Response, text: string;
            try {
            res = await fetch(
              config.storyOrigin + "/internal/v1/agent/tools/execute",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: "Bearer " + capability,
                },
                body: JSON.stringify({
                  sessionId: id,
                  tool: name,
                  arguments: args,
                  ...(mutation && execution ? {messageId: execution.messageId, runId: execution.runId} : {}),
                }),
                signal: AbortSignal.any([signal,deadline]),
                redirect: "error",
              },
            ).catch(() => {throw Error(deadline.aborted && !signal.aborted ? "TOOL_TIMEOUT" : "TOOL_EXECUTION_FAILED")});
            text = await boundedText(
              res,
              config.model.limits.maxToolResultBytes,
            ).catch((e:unknown) => {
              if(e instanceof Error && e.message === "TOOL_RESULT_TOO_LARGE") throw e;
              throw Error(deadline.aborted && !signal.aborted ? "TOOL_TIMEOUT" : "TOOL_EXECUTION_FAILED");
            });
            } catch (error) {
              if (!mutation) throw error;
              report("unknown","OUTCOME_UNKNOWN");
              if (signal.aborted) throw error;
              execution?.persist();
              uncertain.add(name);
              return feedback("OUTCOME_UNKNOWN", "The save outcome is unknown. Do not claim it was saved or issue another batch this reply; the original request is retained for recovery.");
            }
            if (!res.ok) {
              if (mutation && execution && [409,422].includes(res.status)) {
                const problem = JSON.parse(text) as {code?:string; detail?:string};
                delete execution.writes[writeKey];report("failed",problem.code ?? "INVALID_STORY_CHANGE");execution.persist();
                return feedback(problem.code ?? "INVALID_STORY_CHANGE", problem.detail ?? "The change was not applied. Read the latest asset/version or correct the evidence, then retry the batch.");
              }
              if (mutation && res.status >= 500) {
                uncertain.add(name);
                report("unknown","OUTCOME_UNKNOWN");execution?.persist();
                return feedback("OUTCOME_UNKNOWN", "The save outcome is unknown. Do not claim success. Keep the original batch for recovery.");
              }
              report("failed","TOOL_EXECUTION_FAILED");execution?.persist();
              throw Error("TOOL_EXECUTION_FAILED");
            }
            if (mutation && execution) {execution.writes[writeKey] = {arguments: args,tool:name,result: text};reportReceipt(text);execution.persist();}
            const value = JSON.parse(text) as { sources?: unknown[] };
            const sources = (value.sources ?? []).flatMap((src) => {
              const result = thinkingSourceSchema.safeParse(src);
              return result.success ? [result.data] : [];
            });
            onSources(sources);
            return {
              content: [{ type: "text" as const, text }],
              details: { sources },
            };
          },
        }) satisfies ToolDefinition,
    ),
    ...(!scopes.length ? [] : [{
      name: "load_analysis_skill",
      label: "分析方法",
      description:
        "Load exactly one controlled analysis method; this supplies reasoning guidance, never novel facts or permissions.",
      parameters: Type.Object(
        {
          name: Type.Union([
            Type.Literal("character-analysis"),
            Type.Literal("plot-analysis"),
          ]),
        },
        { additionalProperties: false },
      ),
      async execute(_id, args) {
        if (!onCall()) return budgetSpent();
        const name = (args as { name: string }).name;
        if (!["character-analysis", "plot-analysis"].includes(name))
          throw Error("INVALID_SKILL");
        const path = new URL(`../../skills/${name}/SKILL.md`, import.meta.url); // compiled and source layouts are both two levels below app root
        const text = readFileSync(path, "utf8");
        return {
          content: [{ type: "text" as const, text }],
          details: { method: name },
        };
      },
    } satisfies ToolDefinition]),
  ];
}
const toolText = (text: string, details: Record<string, unknown> = {}) => ({content:[{type:"text" as const,text}],details});
const feedback = (code: string, message: string, extra: Record<string, unknown> = {}) => toolText(JSON.stringify({ok:false,code,message,...extra}), {recoverable:true,code});
const budgetSpent = () => ({
  content: [{ type: "text" as const, text: "The lookup budget for this reply is spent. This lookup was not run. Do not call tools again; answer now from available information and state any gaps." }],
  details: { budget: true },
});
export async function boundedText(res: Response, max: number) {
  if (!res.body) throw Error("INVALID_RESPONSE");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > max) throw Error("TOOL_RESULT_TOO_LARGE");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
