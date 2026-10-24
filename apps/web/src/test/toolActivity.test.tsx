import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThinkingEvent, ThinkingSession } from "@writer-agent/contracts";
import { applyToolEvents, type ToolStep } from "../features/thinking/toolActivity";
import { useThinking } from "../features/thinking/useThinking";
import { thinkingApi as api } from "../services/api/thinkingApi";

let n = 0;
const id = () => ++n;
const ev = (type: ThinkingEvent["type"], tool?: string) => ({ type, tool });

describe("applyToolEvents", () => {
  it("adds a running step per tool_started and never scripts steps", () => {
    expect(applyToolEvents([], [], id)).toEqual([]);
    const out = applyToolEvents([], [ev("tool_started", "search_knowledge")], id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tool: "search_knowledge", done: false });
  });

  it("completes the matching tool even when two tools overlap", () => {
    const out = applyToolEvents(
      [],
      [
        ev("tool_started", "search_knowledge"),
        ev("tool_started", "read_chapter"),
        ev("tool_completed", "read_chapter"),
      ],
      id,
    );
    expect(out.map((s) => [s.tool, s.done])).toEqual([
      ["search_knowledge", false],
      ["read_chapter", true],
    ]);
  });

  it("completes the oldest open step when the event names no tool", () => {
    const out = applyToolEvents(
      [],
      [ev("tool_started", "a"), ev("tool_started", "b"), ev("tool_completed")],
      id,
    );
    expect(out.map((s) => s.done)).toEqual([true, false]);
  });

  it("ignores a completion with nothing open and unrelated events", () => {
    const start: ToolStep[] = [{ id: 1, tool: "a", done: true }];
    expect(
      applyToolEvents(start, [ev("tool_completed", "a"), ev("text_delta")], id),
    ).toEqual(start);
  });

  it("caps the list so a runaway session cannot grow without bound", () => {
    const many = Array.from({ length: 100 }, () => ev("tool_started", "search_knowledge"));
    expect(applyToolEvents([], many, id).length).toBeLessThanOrEqual(32);
  });
});

const model: ThinkingSession["model"] = {
  provider: "fixture",
  model: "fixture",
  endpoint: "https://model.example",
  protocol: "thinking-v1",
  limits: {
    maxTurnsPerRequest: 2,
    maxToolCalls: 2,
    maxInputTokens: 32000,
    maxOutputTokens: 100,
    maxSessionTokens: 100000,
    maxConcurrentSessions: 2,
    maxDurationMs: 10000,
    maxToolResultBytes: 1000,
  },
};
const session = (sid: string, status: ThinkingSession["status"] = "idle"): ThinkingSession => ({
  sessionId: sid,
  bookId: "book-a",
  title: sid,
  createdAt: "now",
  model,
  scopes: ["chapters"],
  status,
  messages: [],
  cursor: 0,
  usage: { input: 0, output: 0, charged: 0, incomplete: false },
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("useThinking tool steps", () => {
  it("collects real events and does not leak them into another session", async () => {
    vi.spyOn(api, "capabilities").mockResolvedValue(model);
    vi.spyOn(api, "list").mockResolvedValue([session("A"), session("B")]);
    vi.spyOn(api, "get").mockImplementation(async (_b, sid) =>
      session(sid, sid === "A" ? "running" : "idle"),
    );
    vi.spyOn(api, "events").mockImplementation(async (_b, sid) =>
      sid === "A"
        ? {
            items: [{ type: "tool_started", tool: "read_chapter" } as ThinkingEvent],
            cursor: 1,
            status: "idle",
          }
        : { items: [], cursor: 0, status: "idle" },
    );
    const { result } = renderHook(() => useThinking("book-a", true));
    act(() => result.current.select("A"));
    await waitFor(() => expect(result.current.steps).toHaveLength(1));
    expect(result.current.steps[0]).toMatchObject({ tool: "read_chapter", done: false });
    act(() => result.current.select("B"));
    await waitFor(() => expect(result.current.session?.sessionId).toBe("B"));
    expect(result.current.steps).toEqual([]);
  });

  it("a new turn starts with an empty timeline once the message is accepted", async () => {
    vi.spyOn(api, "capabilities").mockResolvedValue(model);
    vi.spyOn(api, "list").mockResolvedValue([session("A")]);
    let served = false;
    vi.spyOn(api, "get").mockImplementation(async (_b, sid) =>
      session(sid, served ? "idle" : "running"),
    );
    vi.spyOn(api, "events").mockImplementation(async () => {
      if (served) return { items: [], cursor: 1, status: "idle" as const };
      served = true;
      return {
        items: [
          { type: "tool_started", tool: "search_knowledge" } as ThinkingEvent,
          { type: "tool_completed", tool: "search_knowledge" } as ThinkingEvent,
        ],
        cursor: 2,
        status: "idle" as const,
      };
    });
    vi.spyOn(api, "send").mockResolvedValue({ messageId: "m" });
    const { result } = renderHook(() => useThinking("book-a", true));
    act(() => result.current.select("A"));
    await waitFor(() => expect(result.current.steps).toHaveLength(1));
    expect(result.current.steps[0].done).toBe(true);
    act(() => result.current.send({ text: "next" }));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.steps).toEqual([]);
  });
});
