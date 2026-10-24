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
// Creative tools read author-owned assets. request_turn_organize only queues
// organizing of the current turn into proposals; no tool writes assets.
const descriptions: Partial<Record<(typeof storyNames)[number], string>> = {
  list_creative_assets:
    "List the author's creative assets (characters, world rules, plans, foreshadowing, open questions). Optional kind and query. accepted = author-confirmed; draft = author draft. Plans are intentions, not manuscript facts.",
  get_creative_asset: "Read one creative asset by assetId with its links.",
  list_creative_proposals:
    "List UNCONFIRMED AI proposals awaiting author review. Never treat them as canon; label them as possibilities.",
  list_open_questions: "List the author's undecided questions and pending question proposals.",
  get_writing_context:
    "For chapterId, return author-confirmed plans, characters, rules and payoffs relevant to that chapter.",
  compare_plan_with_manuscript:
    "For chapterId, return accepted plans next to AI manuscript observations and recorded divergences. A difference is a question for the author, not an error.",
  request_turn_organize:
    "Queue organizing of the current discussion turn into reviewable proposals after this reply. Use only when the author asks to record or organize ideas. Nothing becomes canon automatically.",
};
export async function authorize(
  config: Config,
  capability: string,
  signal?: AbortSignal,
) {
  const res = await fetch(config.storyOrigin + "/internal/v1/agent/authorize", {
    method: "POST",
    headers: { Authorization: "Bearer " + capability },
    signal,
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
): ToolDefinition[] {
  const parameters = Type.Object(
    {
      quote: Type.Optional(Type.String({ maxLength: 4000 })),
      query: Type.Optional(Type.String({ maxLength: 256 })),
      chapterId: Type.Optional(Type.String({ maxLength: 128 })),
      revisionId: Type.Optional(Type.String({ maxLength: 128 })),
      entityId: Type.Optional(Type.String({ maxLength: 128 })),
      startUTF16: Type.Optional(Type.Integer({ minimum: 0 })),
      assetId: Type.Optional(Type.String({ maxLength: 128 })),
      kind: Type.Optional(Type.String({ maxLength: 40 })),
    },
    { additionalProperties: false },
  );
  return [
    ...storyNames.map(
      (name) =>
        ({
          name,
          label: name,
          description:
            descriptions[name] ??
            `Read-only author-scoped Story Tool: ${name}. No paths, bookId or authorId accepted. Chapter windows are limited; follow truncated/totalUTF16 to retrieve more.`,
          parameters,
          async execute(_id, args) {
            onCall();
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
    {
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
    } satisfies ToolDefinition,
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
