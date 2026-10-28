import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PiHost, AgentError } from "../src/runtime/pi-host.js";
import { Store } from "../src/sessions/store.js";
import type { Config } from "../src/config.js";
const listen = async (s: ReturnType<typeof createServer>) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};
test("input/session budgets block before provider; concurrency, deadline and absent-session tombstone", async () => {
  const state = mkdtempSync(join(tmpdir(), "pi-budget-"));
  let network = 0;
  const provider = createServer((_req, res) => {
    network++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
  });
  const story = createServer((req, res) => {
    const id = req.headers.authorization!.slice(7);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        sessionId: id,
        authorId: "a",
        bookId: "b",
        model: config.model,
        scopes: ["chapters"],
      }),
    );
  });
  const config: Config = {
    state,
    port: 1,
    storyOrigin: await listen(story),
    key: "fixture",
    token: "x".repeat(64),
    version: "test",
    model: {
      provider: "fixture",
      model: "fixture",
      endpoint: await listen(provider),
      protocol: "thinking-v1",
      limits: {
        maxTurnsPerRequest: 2,
        maxToolCalls: 2,
        maxInputTokens: 1,
        maxOutputTokens: 100,
        maxSessionTokens: 200000,
        maxConcurrentSessions: 1,
        maxDurationMs: 4000,
        maxToolResultBytes: 1000,
      },
    },
  };
  const host = new PiHost(config, new Store(state));
  const create = async () => {
    const id = "th-" + randomUUID();
    await host.create({
      sessionId: id,
      authorId: "a",
      bookId: "b",
      model: config.model,
      scopes: ["chapters"],
      createdAt: "now",
      capability: id,
    });
    return id;
  };
  const send = async (id: string) => {
    await host.accept(id, { text: "Synthetic question" }, "key", id);
    await host.active.get(id)?.done;
    return host.get(id).view.messages.at(-1)!;
  };
  try {
    let id = await create();
    assert.equal((await send(id)).errorCode, "INPUT_BUDGET_EXCEEDED");
    assert.equal(network, 0);
    config.model.limits.maxInputTokens = 32000;
    config.model.limits.maxSessionTokens = 1;
    id = await create();
    assert.equal((await send(id)).errorCode, "SESSION_BUDGET_EXCEEDED");
    assert.equal(network, 0);
    config.model.limits.maxSessionTokens = 200000;
    id = await create();
    const other = await create();
    await host.accept(id, { text: "Hang" }, "hang", id);
    await assert.rejects(
      host.accept(other, { text: "Second" }, "other", other),
      (e) => e instanceof AgentError && e.code === "AGENT_BUSY",
    );
    await host.active.get(id)?.done;
    assert.equal(
      host.get(id).view.messages.at(-1)?.errorCode,
      "DURATION_EXCEEDED",
    );
    assert.equal(network, 1);
    const deleted = "th-" + randomUUID();
    await host.delete(deleted);
    await assert.rejects(
      host.create({
        sessionId: deleted,
        authorId: "a",
        bookId: "b",
        model: config.model,
        scopes: ["chapters"],
        createdAt: "now",
        capability: deleted,
      }),
      (e) => e instanceof AgentError && e.code === "SESSION_DELETED",
    );
    assert.throws(() => host.store.path("../other-book"));
    assert.throws(() => new Store(state), /AGENT_ALREADY_RUNNING/);
  } finally {
    await host.close();
    provider.closeAllConnections();
    story.closeAllConnections();
    provider.close();
    story.close();
    rmSync(state, { recursive: true, force: true });
  }
});
