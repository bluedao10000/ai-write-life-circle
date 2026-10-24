import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import type { ThinkingSession } from "@writer-agent/contracts";
import { useThinking } from "../features/thinking/useThinking";
import { thinkingApi as api } from "../services/api/thinkingApi";
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
const session = (id: string): ThinkingSession => ({
  sessionId: id,
  bookId: "book-a",
  title: id,
  createdAt: "now",
  model,
  scopes: ["chapters"],
  status: "idle",
  messages: [],
  cursor: 0,
  usage: { input: 0, output: 0, charged: 0, incomplete: false },
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
function setup() {
  vi.spyOn(api, "capabilities").mockResolvedValue(model);
  vi.spyOn(api, "list").mockResolvedValue([session("A"), session("B")]);
  vi.spyOn(api, "get").mockImplementation(async (_b, id) => session(id));
  vi.spyOn(api, "events").mockResolvedValue({
    items: [],
    cursor: 0,
    status: "idle",
  });
  return renderHook(() => useThinking("book-a", true));
}
it("late cancellation for A cannot overwrite B or clear B pending action", async () => {
  const a = deferred<ThinkingSession>(),
    b = deferred<{ messageId: string }>();
  vi.spyOn(api, "cancel").mockImplementation(() => a.promise);
  vi.spyOn(api, "send").mockImplementation(() => b.promise);
  const { result } = setup();
  act(() => result.current.select("A"));
  await waitFor(() => expect(result.current.session?.sessionId).toBe("A"));
  act(() => result.current.cancel());
  await waitFor(() => expect(result.current.busy).toBe(true));
  act(() => result.current.select("B"));
  await waitFor(() => expect(result.current.session?.sessionId).toBe("B"));
  act(() => result.current.send({ text: "B question" }));
  await waitFor(() => expect(result.current.busy).toBe(true));
  await act(async () => {
    a.resolve(session("A"));
  });
  expect(result.current.session?.sessionId).toBe("B");
  expect(result.current.busy).toBe(true);
  await act(async () => {
    b.resolve({ messageId: "B-message" });
  });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.session?.sessionId).toBe("B");
});
it("transport retry preserves accepted intent key; successful admission clears the draft", async () => {
  const send = vi
    .spyOn(api, "send")
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({ messageId: "accepted" });
  const { result } = setup();
  act(() => result.current.select("A"));
  await waitFor(() => expect(result.current.session?.sessionId).toBe("A"));
  act(() => {
    result.current.setDraft("same question");
    result.current.send({ text: "same question" });
  });
  await waitFor(() => expect(result.current.error).toContain("network"));
  expect(result.current.draft).toBe("same question");
  act(() => result.current.send({ text: "same question" }));
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(send.mock.calls[0][3]).toBe(send.mock.calls[1][3]);
  expect(result.current.draft).toBe("");
});
it("offline capabilities do not hide Go history or block durable deletion", async () => {
  const { result } = setup();
  vi.mocked(api.capabilities).mockRejectedValue(new Error("Agent offline"));
  vi.mocked(api.get).mockRejectedValue(new Error("Agent offline"));
  const remove = vi.spyOn(api, "delete").mockResolvedValue();
  await act(async () => {
    await result.current.reload();
  });
  await waitFor(() => expect(result.current.sessions).toHaveLength(2));
  expect(result.current.model).toBeNull();
  act(() => result.current.select("A"));
  await waitFor(() => expect(result.current.error).toContain("offline"));
  act(() => result.current.remove());
  await waitFor(() => expect(remove).toHaveBeenCalledWith("book-a", "A"));
  await waitFor(() => expect(result.current.selected).toBeNull());
  expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["B"]);
});
