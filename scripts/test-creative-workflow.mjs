// End-to-end V3 workflow with real Go API, Pi Thinking and Go Agent Worker
// processes against a local OpenAI-compatible fixture. No paid model is called.
// Scenarios: A (from zero), C (alternatives), D (write then return), E (plan
// divergence), F (deletion invalidates derived work).
import assert from "node:assert/strict";
import { identityFixture } from "./lib/identity-fixture.mjs";
const identity = identityFixture();
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const listen = async (s) => {
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s.address().port;
};
const free = async () => {
  const s = createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
};
const root = await mkdtemp(join(tmpdir(), "story2u-creative-"));
const secrets = {};
for (const name of ["bearer", "token", "secret"]) {
  secrets[name] = randomBytes(32).toString("hex");
  await writeFile(join(root, name), secrets[name], { mode: 0o600 });
}
await mkdir(join(root, "harness"));
const calls = { chat: 0, organize: 0, plan: 0 };

// Deterministic stand-in for the model: echo chat, and organize by keywords.
function organize(input) {
  const [user] = input.focusMessageIds;
  const text = input.conversation.find((m) => m.messageId === user)?.text ?? "";
  const ev = (quote) => [{ messageId: user, quote }];
  if (text.includes("灯塔看守人"))
    return {
      summary: "确定主角与世界规则",
      noChange: false,
      changes: [
        { ref: "hero", operation: "CREATE", stance: "author_decision", kind: "character", name: "林舟", fields: [{ key: "身份", value: "灯塔看守人" }], evidence: ev("主角叫林舟，是灯塔看守人") },
        { ref: "rule", operation: "CREATE", stance: "author_decision", kind: "world_rule", name: "潮汐禁令", summary: "满月夜任何人不得出海", evidence: ev("满月夜任何人不得出海") },
      ],
    };
  if (text.includes("或者"))
    return {
      summary: "三种结局",
      noChange: false,
      changes: ["牺牲", "出走", "回归"].map((x) => ({ ref: x, operation: "CREATE", stance: "author_hypothesis", alternativeGroup: "结局", kind: "plot_line", name: "结局：" + x, evidence: ev("或者他" + x) })),
    };
  return { summary: "闲聊", noChange: true, noChangeReason: "没有新的设定", changes: [] };
}
function planCheck(input) {
  return { checks: input.plans.map((p) => ({ assetId: p.assetId, assessment: "diverged", quote: "他最终选择留下", explanation: "计划是背叛，正文中他留下了。", question: "要修改计划，还是推迟背叛？" })) };
}
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.stream) {
    calls.chat++;
    const user = body.messages.findLast((m) => m.role === "user");
    const said = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish = null, usage) => "data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + "\n\n";
    res.write(chunk({ content: "我理解你的构思：" + said.slice(0, 40) + "。这些还需要你确认。" }));
    res.write(chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }));
    res.end("data: [DONE]\n\n");
    return;
  }
  const input = JSON.parse(body.messages[1].content);
  let out;
  if (body.messages[0].content.startsWith("You organize")) {
    calls.organize++;
    out = organize(input);
  } else {
    calls.plan++;
    out = planCheck(input);
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 100 } }));
});
const providerOrigin = `http://127.0.0.1:${await listen(provider)}`;
const agentPort = await free(), toolPort = await free();
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("WRITER_AGENT_"))),
  NODE_ENV: "production",
  WRITER_AGENT_ENV: "production",
  WRITER_AGENT_AUTH_MODE: "bearer",
  WRITER_AGENT_AUTH_TOKEN_FILE: join(root, "bearer"),
  WRITER_AGENT_AUTHOR_ID: "fixture-author",
  ...identity.goEnv,
  WRITER_AGENT_PROJECT_ID: "empty-external",
  WRITER_AGENT_API_PORT: "0",
  WRITER_AGENT_API_HOST: "127.0.0.1",
  WRITER_AGENT_HARNESS_ROOT: join(root, "harness"),
  WRITER_AGENT_STATE_DIR: join(root, "go-state"),
  WRITER_AGENT_LLM_PROVIDER: "openai-compatible",
  WRITER_AGENT_LLM_BASE_URL: providerOrigin,
  WRITER_AGENT_LLM_API_KEY: "",
  WRITER_AGENT_LLM_MODEL: "creative-fixture",
  WRITER_AGENT_LLM_RESPONSE_FORMAT: "json_object",
  WRITER_AGENT_LLM_TOKEN_PARAMETER: "max_tokens",
  WRITER_AGENT_LLM_TIMEOUT_SECONDS: "5",
  WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS: "2048",
  WRITER_AGENT_PI_ORIGIN: `http://127.0.0.1:${agentPort}`,
  WRITER_AGENT_PI_SERVICE_TOKEN_FILE: join(root, "token"),
  WRITER_AGENT_PI_CAPABILITY_KEY_FILE: join(root, "secret"),
  WRITER_AGENT_PI_INTERNAL_PORT: String(toolPort),
  WRITER_AGENT_PI_PORT: String(agentPort),
  WRITER_AGENT_PI_STORY_ORIGIN: `http://127.0.0.1:${toolPort}`,
  WRITER_AGENT_PI_STATE_DIR: join(root, "pi-state"),
  WRITER_AGENT_PI_LLM_API_KEY: "synthetic-fixture-only",
  WRITER_AGENT_PI_LLM_BASE_URL: providerOrigin,
  WRITER_AGENT_PI_LLM_PROVIDER: "fixture",
  WRITER_AGENT_PI_LLM_MODEL: "synthetic-thinking",
  WRITER_AGENT_PI_FIXTURE: "1",
  WRITER_AGENT_PI_MAX_DURATION_MS: "10000",
  WRITER_AGENT_PI_VERSION: "fixture",
};
let output = "", errors = "";
const children = [];
const start = (cmd, args) => {
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (errors += d));
  children.push(child);
  return child;
};
const bin = (name) => new URL(`../apps/api-go/dist/${name}`, import.meta.url).pathname;
async function close() {
  for (const child of children.reverse())
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((r) => child.once("exit", r)), delay(6000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
  await rm(root, { recursive: true, force: true });
}
try {
  start(bin("writer-agent-api"), []);
  start(process.execPath, [new URL("../apps/agent/dist/main.js", import.meta.url).pathname]);
  let api;
  for (let i = 0; i < 200 && !(api && output.includes("agent_started")); i++) {
    api = output.match(/API listening on (http:\/\/[^\s]+)/)?.[1];
    await delay(50);
  }
  assert(api && output.includes("agent_started"), "startup: " + errors);
  start(bin("writer-agent-worker"), []);
  const call = async (path, { method = "GET", body, key, status = 200 } = {}) => {
    const r = await fetch(api + path, {
      method,
      headers: { Authorization: "Bearer " + secrets.bearer, ...identity.headers(method, path), ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = r.status === 204 ? null : await r.json();
    if (r.status !== status) throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(value)}`);
    return value;
  };
  const until = async (fn, label, ms = 20000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw Error("timeout: " + label + "\n" + errors);
      await delay(150);
    }
  };
  // Scenario A: a new book without any manuscript text.
  const book = await call("/v1/studio/books", { method: "POST", body: { operation: "create", baseVersion: 0, title: "从零开始" }, key: "book", status: 201 });
  const base = `/v1/studio/books/${book.bookId}`;
  const creative = base + "/creative";
  let overview = await call(creative);
  assert.equal(overview.settings.enabled, false);
  await call(creative + "/settings/enable", { method: "POST", key: "enable", body: { consent: true, model: overview.settings.currentModel, dailyTokenBudget: Math.max(overview.settings.reserveTokens * 10, 1000000), dailyJobBudget: 50 } });
  const model = await call(base + "/thinking/capabilities");
  const session = await call(base + "/thinking/sessions", { method: "POST", key: "session", status: 201, body: { consent: true, model, scopes: ["chapters", "knowledge", "creative"] } });
  const sessionPath = `${base}/thinking/sessions/${session.sessionId}`;
  const say = async (text, key) => {
    const { messageId } = await call(sessionPath + "/messages", { method: "POST", key, status: 202, body: { text } });
    await until(async () => (await call(sessionPath)).status === "idle", "reply " + key);
    return messageId;
  };
  const organized = (messageId) =>
    until(async () => {
      const { items } = await call(`${creative}/turns?sessionId=${session.sessionId}`);
      const t = items.find((x) => x.messageId === messageId);
      return t && !["awaiting", "queued"].includes(t.status) ? t : null;
    }, "organize " + messageId);
  const m1 = await say("主角叫林舟，是灯塔看守人。这个世界里，满月夜任何人不得出海。", "m1");
  assert.equal((await call(sessionPath)).messages.at(-1).status, "completed", "reply first, organize later");
  const t1 = await organized(m1);
  assert.equal(t1.status, "organized", JSON.stringify(t1));
  let pending = await call(`${creative}/proposals?status=proposed&sessionId=${session.sessionId}`);
  assert.equal(pending.items.length, 2);
  assert.equal((await call(creative + "/assets")).total, 0, "proposals are not canon");
  for (const p of pending.items) {
    assert.equal(p.source.type, "conversation");
    assert.equal(p.source.messageId, m1);
    assert.equal(p.evidence[0].role, "user");
  }
  await call(creative + "/proposals/decide", { method: "POST", key: "accept-a", body: { decisions: pending.items.map((p) => ({ proposalId: p.proposalId, action: "accept" })) } });
  const assets = await call(creative + "/assets");
  assert.equal(assets.total, 2);
  assert(assets.items.every((a) => a.status === "accepted" && a.origin === "conversation"));
  // Scenario C: three possibilities stay exploratory and mutually exclusive.
  const m2 = await say("结局还没想好：或者他牺牲，或者他出走，或者他回归。", "m2");
  await organized(m2);
  pending = await call(`${creative}/proposals?status=proposed&sessionId=${session.sessionId}`);
  assert.equal(pending.items.length, 3);
  assert(pending.items.every((p) => p.exploratory && p.alternativeGroup === pending.items[0].alternativeGroup));
  await call(creative + "/proposals/decide", { method: "POST", key: "accept-all-c", status: 409, body: { decisions: pending.items.map((p) => ({ proposalId: p.proposalId, action: "accept" })) } });
  assert.equal((await call(creative + "/assets?kind=plot_line")).total, 0);
  // Scenario D + E: write a chapter that departs from an accepted plan.
  const chapter = book.chapters[0].chapterId;
  const plan = await call(creative + "/assets", { method: "POST", key: "plan", status: 201, body: { kind: "event", status: "accepted", content: { name: "林舟背叛组织", aliases: [], summary: "林舟将在本章背叛组织", fields: [], plan: { chapterId: chapter } } } });
  const chapterPath = `/v1/projects/${book.bookId}/chapters/${chapter}`;
  const head = await call(chapterPath);
  const text = "夜里他收拾好行囊。\n\n可天亮时，他最终选择留下。";
  const saved = await call(chapterPath + "/revisions", { method: "POST", key: "save-1", status: 201, body: { baseRevisionId: head.headRevision.revisionId, markdown: text } });
  const context = await call(`${creative}/context?chapterId=${chapter}`);
  assert.equal(context.plans.length, 1);
  await call(creative + "/plan-checks", { method: "POST", key: "check-1", status: 202, body: { chapterId: chapter } });
  const divergence = await until(async () => (await call(`${creative}/divergences?chapterId=${chapter}`)).items[0], "plan check");
  assert.equal(divergence.assessment, "diverged");
  assert.equal(divergence.evidence.quote, "他最终选择留下");
  await call(`${creative}/divergences/${divergence.divergenceId}/decide`, { method: "POST", key: "keep", body: { action: "intentional" } });
  const after = await call(`${creative}/assets/${plan.assetId}`);
  assert.equal(after.asset.version, 1, "plan must not change automatically");
  assert.equal((await call(chapterPath)).headRevision.revisionId, saved.revisionId, "manuscript must not change");
  // Returning to the inspiration session still works after writing.
  const m3 = await say("写完第一章了，我们聊聊他为什么留下。", "m3");
  assert.equal((await organized(m3)).status, "no_change");
  // Scenario F: idempotent replay and deletion invalidating derived work.
  const replay = await call(sessionPath + "/messages", { method: "POST", key: "m3", status: 202, body: { text: "写完第一章了，我们聊聊他为什么留下。" } });
  assert.equal(replay.messageId, m3);
  await call(sessionPath, { method: "DELETE", status: 204 });
  pending = await call(`${creative}/proposals?sessionId=${session.sessionId}`);
  assert(pending.items.filter((p) => p.status === "proposed").length === 0, "deleted session keeps no pending proposals");
  assert(pending.items.filter((p) => p.status === "expired").length === 3);
  assert((await call(creative + "/assets")).total >= 3, "accepted settings survive session deletion");
  assert.equal(calls.organize, 3);
  assert.equal(calls.plan, 1);
  console.log(JSON.stringify({ ok: true, calls }));
} catch (e) {
  console.error(errors.slice(-4000));
  throw e;
} finally {
  await close();
}
