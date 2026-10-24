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
] as const;
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
    },
    { additionalProperties: false },
  );
  return [
    ...storyNames.map(
      (name) =>
        ({
          name,
          label: name,
          description: `Read-only author-scoped Story Tool: ${name}. No paths, bookId or authorId accepted. Chapter windows are limited; follow truncated/totalUTF16 to retrieve more.`,
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
