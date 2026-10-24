import type { ThinkingEvent } from "@writer-agent/contracts";

export type ToolStep = { id: number; tool: string; done: boolean };

/** Hard cap so a runaway session cannot grow the list without bound. */
const MAX_STEPS = 32;

/**
 * Folds real Thinking events into the visible tool timeline. Only `tool_started`
 * and `tool_completed` matter; every step shown corresponds to an event the Go
 * service actually emitted. Nothing is scripted or pre-filled.
 */
export function applyToolEvents(
  steps: ToolStep[],
  events: Pick<ThinkingEvent, "type" | "tool">[],
  nextId: () => number,
): ToolStep[] {
  let out = steps;
  for (const event of events) {
    if (event.type === "tool_started") {
      out = [...out, { id: nextId(), tool: event.tool ?? "", done: false }].slice(
        -MAX_STEPS,
      );
    } else if (event.type === "tool_completed") {
      // Complete the oldest unfinished step of this tool (events arrive in order).
      const index = out.findIndex(
        (s) => !s.done && (event.tool === undefined || s.tool === event.tool),
      );
      const target = index >= 0 ? index : out.findIndex((s) => !s.done);
      if (target >= 0)
        out = out.map((s, i) => (i === target ? { ...s, done: true } : s));
    }
  }
  return out;
}
