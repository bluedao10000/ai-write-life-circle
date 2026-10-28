import { Type } from "typebox";
import { readFileSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  thinkingSourceSchema,
  thinkingGrantSchema,
  type ThinkingSource,
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
] as const;
// Creative tools read author-owned assets; request_turn_organize only queues
// organizing into proposals. No tool writes assets. They are registered only
// for sessions granted the "creative" scope, with narrow argument schemas to
// keep every paid request small.
const creativeNames = new Set<string>([
  "list_creative_assets",
  "get_creative_asset",
  "list_creative_proposals",
  "list_open_questions",
  "get_writing_context",
  "compare_plan_with_manuscript",
  "request_turn_organize",
]);
const descriptions: Partial<Record<(typeof storyNames)[number], string>> = {
  list_creative_assets: "Author's creative assets (optional kind, query). accepted=confirmed, draft=draft; plans are intentions.",
  get_creative_asset: "One creative asset by assetId, with links.",
  list_creative_proposals: "UNCONFIRMED AI proposals awaiting review; never canon.",
  list_open_questions: "Author's undecided questions.",
  get_writing_context: "Confirmed plans, characters and rules for chapterId.",
  compare_plan_with_manuscript: "Plans for chapterId beside AI manuscript observations; differences are questions, not errors.",
  request_turn_organize: "Queue organizing this turn into proposals for author review. Only when the author asks.",
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
  });
  if (!res.ok) throw Error("AUTHORIZATION_REVOKED");
  return thinkingGrantSchema.parse(await res.json());
}
export function tools(
  config: Config,
  id: string,
  capability: string,
  signal: AbortSignal,
  onSources: (v: ThinkingSource[]) => void,
  onCall: () => void,
  scopes: readonly string[] = [],
): ToolDefinition[] {
  const seen = new Set<string>();
  const id128 = Type.String({ maxLength: 128 });
  const narrow: Record<string, ReturnType<typeof Type.Object>> = {
    list_creative_assets: Type.Object({ query: Type.Optional(Type.String({ maxLength: 256 })), kind: Type.Optional(Type.String({ maxLength: 40 })) }, { additionalProperties: false }),
    get_creative_asset: Type.Object({ assetId: id128 }, { additionalProperties: false }),
    get_writing_context: Type.Object({ chapterId: id128 }, { additionalProperties: false }),
    compare_plan_with_manuscript: Type.Object({ chapterId: id128 }, { additionalProperties: false }),
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
  const granted = storyNames.filter((name) => scopes.includes(creativeNames.has(name) ? "creative" : name === "get_author_notes" ? "notes" : ["read_chapter", "find_related_chapters"].includes(name) ? "chapters" : "knowledge"));
  return [
    ...granted.map(
      (name) =>
        ({
          name,
          label: name,
          description:
            descriptions[name] ??
            `Read-only author-scoped Story Tool: ${name}. No paths, bookId or authorId accepted. Chapter windows are limited; follow truncated/totalUTF16 to retrieve more.`,
          parameters: creativeNames.has(name) ? (narrow[name] ?? empty) : parameters,
          async execute(_id, args) {
            onCall();
            const fingerprint = JSON.stringify([name, args]);
            if (seen.has(fingerprint)) return {content: [{type: "text" as const, text: "This exact lookup was already attempted. Do not repeat it. Answer using available information and explain any gaps."}], details: {duplicate: true}};
            seen.add(fingerprint);
            const res = await fetch(
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
                }),
                signal,
                redirect: "error",
              },
            );
            const text = await boundedText(
              res,
              config.model.limits.maxToolResultBytes,
            );
            if (!res.ok) throw Error("STORY_TOOL_FAILED");
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
        onCall();
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
