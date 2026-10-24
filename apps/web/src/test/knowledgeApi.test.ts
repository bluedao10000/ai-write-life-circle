import { beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeApi } from "../services/api/knowledgeApi";

const model = {
  provider: "openai-compatible",
  model: "fixture",
  endpoint: "http://localhost",
  execution: "local",
};

const view = {
  bookId: "book-a",
  version: 1,
  budgetDay: "",
  budgetTokens: 0,
  budgetAttempts: 0,
  settings: {
    enabled: true,
    paused: false,
    model,
    dailyTokenBudget: 100000,
    dailyJobBudget: 20,
  },
  available: true,
  model,
  disclosure: "fixture",
  pending: 0,
  running: 0,
  failed: 0,
  stale: false,
};

describe("knowledge API", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts durable partial-extraction counters in job records", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              jobId: "job-1",
              chapterId: "CH-000001",
              revisionId: "draft:1",
              contentHash: "sha256:a",
              strategyVersion: "knowledge-extraction-v1",
              model,
              status: "completed",
              attempts: 1,
              nextAttemptAt: "2026-10-23T00:00:00Z",
              reservedTokens: 100,
              durationMs: 10,
              createdAt: "2026-10-23T00:00:00Z",
              discardedAliases: 1,
              discardedAssertions: 2,
              discardedEntities: 3,
            },
          ],
          total: 1,
          nextCursor: null,
        }),
        { status: 200 },
      ),
    );

    const result = await knowledgeApi.jobs("book-a");
    expect(result.items[0]?.discardedEntities).toBe(3);
  });

  it("reads a lightweight summary without job rows", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));

    await expect(knowledgeApi.summary("book-a")).resolves.toMatchObject({
      bookId: "book-a",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/v1/studio/books/book-a/knowledge/summary",
    );
  });

  it("turns strict response validation details into a short author message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ unexpected: "raw-json-details" }), {
        status: 200,
      }),
    );

    await expect(knowledgeApi.jobs("book-a")).rejects.toThrow(
      "作品记忆响应格式已更新，请刷新页面后重试。",
    );
  });
});
