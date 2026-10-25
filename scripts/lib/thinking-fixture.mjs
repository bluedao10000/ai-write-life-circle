// Real Go and Pi processes with an isolated OpenAI-compatible HTTP fixture.
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { identityFixture } from "./identity-fixture.mjs";
const listen = async (s, port = 0) => {
  await new Promise((r) => s.listen(port, "127.0.0.1", r));
  return s.address().port;
};
const free = async () => {
  const s = createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
};
export async function startThinkingFixture({ live = false, taskProtocol = false } = {}) {
  // Go runs in production mode, so every author call carries a signed user.
  const identity = identityFixture();
  if (live && !process.env.WRITER_AGENT_LLM_API_KEY)
    throw Error("MODEL_KEY_REQUIRED_FOR_SYNTHETIC_EVAL");
  const root = await mkdtemp(join(tmpdir(), "story2u-thinking-")),
    bearer = randomBytes(32).toString("hex"),
    token = randomBytes(32).toString("hex"),
    secret = randomBytes(32).toString("hex"),
 taskToken=randomBytes(32).toString("hex");
  await mkdir(join(root, "harness"));
  for (const [name, value] of Object.entries({ bearer, token, secret, taskToken }))
    await writeFile(join(root, name), value, { mode: 0o600 });
  const calls = [],
    tools = [],
    config = { hang: false, unknown: false };
  let api, agent, apiOrigin;
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (config.hang) {
      res.flushHeaders();
      return;
    }
    const lastUser = body.messages.findLastIndex((m) => m.role === "user"),
      history = body.messages.slice(lastUser + 1),
      results = history
        .filter((m) => m.role === "tool")
        .flatMap((m) => {
          try {
            return [JSON.parse(m.content)];
          } catch {
            return [];
          }
        });
    const related = results.find((r) => r.items),
      sources = results.flatMap((r) => r.sources ?? []);
    let delta;
    if (config.unknown)
      delta = {
        tool_calls: [
          {
            index: 0,
            id: "evil",
            type: "function",
            function: { name: "bash", arguments: '{"command":"cat /secrets"}' },
          },
        ],
      };
    else if (!related)
      delta = {
        tool_calls: [
          {
            index: 0,
            id: "related-" + calls.length,
            type: "function",
            function: {
              name: "find_related_chapters",
              arguments: JSON.stringify({ query: "林舟 父亲 保护" }),
            },
          },
        ],
      };
    else if (!sources.length)
      delta = {
        tool_calls: related.items.slice(0, 3).map((c, index) => ({
          index,
          id: "read-" + index + "-" + calls.length,
          type: "function",
          function: {
            name: "read_chapter",
            arguments: JSON.stringify({
              chapterId: c.chapterId,
              revisionId: c.revisionId,
            }),
          },
        })),
      };
    else
      delta = {
        content:
          "林舟与父亲从争执到理解，可能由信息差与保护动机推动；这是一种解释，并非作者已经确认的事实。" +
          sources.map((s) => `[[source:${s.sourceId}]]`).join(""),
      };
    if (delta.tool_calls)
      tools.push(...delta.tool_calls.map((t) => t.function.name));
    const send = (part) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "synthetic",
            object: "chat.completion.chunk",
            model: "fixture",
            choices: [{ index: 0, delta: part, finish_reason: null }],
          }) +
          "\n\n",
      );
    if (delta.content) {
      const a = delta.content.slice(0, 35),
        b = delta.content.slice(35);
      send({ content: a });
      await delay(100);
      send({ content: b });
    } else send(delta);
    res.write(
      "data: " +
        JSON.stringify({
          id: "synthetic",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: delta.tool_calls ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: 300,
            completion_tokens: 100,
            total_tokens: 400,
          },
        }) +
        "\n\n",
    );
    res.end("data: [DONE]\n\n");
  });
  const providerPort = await listen(provider),
    agentPort = await free(),
    toolPort = await free(),
 taskPort=await free();
  let output = "",
    errors = "";
  const env = {
    ...process.env,
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
    WRITER_AGENT_LLM_API_KEY: "",
    WRITER_AGENT_LLM_BASE_URL: "",
    WRITER_AGENT_PI_ORIGIN: `http://127.0.0.1:${agentPort}`,
    WRITER_AGENT_PI_SERVICE_TOKEN_FILE: join(root, "token"),
    WRITER_AGENT_PI_CAPABILITY_KEY_FILE: join(root, "secret"),
    WRITER_AGENT_PI_INTERNAL_PORT: String(toolPort),
    WRITER_AGENT_PI_PORT: String(agentPort),
    WRITER_AGENT_PI_STORY_ORIGIN: `http://127.0.0.1:${toolPort}`,
    WRITER_AGENT_PI_STATE_DIR: join(root, "pi-state"),
    WRITER_AGENT_PI_LLM_API_KEY: live
      ? process.env.WRITER_AGENT_LLM_API_KEY
      : "synthetic-fixture-only",
    WRITER_AGENT_PI_LLM_BASE_URL: live
      ? process.env.WRITER_AGENT_LLM_BASE_URL || "https://api.deepseek.com"
      : `http://127.0.0.1:${providerPort}`,
    WRITER_AGENT_PI_LLM_PROVIDER: live ? "deepseek" : "fixture",
    WRITER_AGENT_PI_LLM_MODEL: live
      ? process.env.WRITER_AGENT_LLM_MODEL || "deepseek-flash"
      : "synthetic-thinking",
    WRITER_AGENT_PI_FIXTURE: live ? "" : "1",
    WRITER_AGENT_PI_MAX_DURATION_MS: live ? "120000" : "10000",
    WRITER_AGENT_PI_MAX_TURNS: "4",
    // Fixture-only: V3 creative tools add ~2 KiB to each conservative reservation.
    WRITER_AGENT_PI_MAX_SESSION_TOKENS: live?"64000":"260000",
    WRITER_AGENT_PI_MAX_OUTPUT_TOKENS: "1024",
    WRITER_AGENT_PI_VERSION: "fixture",
  };
  env.WRITER_AGENT_TASK_SERVICE_TOKEN_FILE=taskProtocol?join(root,"taskToken"):"";
  if(taskProtocol)Object.assign(env,{
    WRITER_AGENT_TASK_INTERNAL_PORT:String(taskPort),
    WRITER_AGENT_LLM_BASE_URL:`http://127.0.0.1:${providerPort}`,
    WRITER_AGENT_LLM_PROVIDER:"openai-compatible",WRITER_AGENT_LLM_MODEL:"synthetic-thinking",
    WRITER_AGENT_LLM_RESPONSE_FORMAT:"json_object",WRITER_AGENT_LLM_TOKEN_PARAMETER:"max_tokens",
    WRITER_AGENT_LLM_TIMEOUT_SECONDS:"5",WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS:"2048",
    WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS:"12000"
  });
  const startAgent = () => {
    agent = spawn(
      process.execPath,
      [new URL("../../apps/agent/dist/main.js", import.meta.url).pathname],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    agent.stdout.on("data", (d) => {
      output += d;
    });
    agent.stderr.on("data", (d) => {
      errors += d;
    });
    return agent;
  };
  const close = async () => {
    for (const child of [agent, api])
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((r) => child.once("exit", r)),
          delay(6000),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
    await rm(root, { recursive: true, force: true });
  };
  try {
    api = spawn(
      new URL("../../apps/api-go/dist/writer-agent-api", import.meta.url)
        .pathname,
      [],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    api.stdout.on("data", (d) => {
      output += d;
    });
    api.stderr.on("data", (d) => {
      errors += d;
    });
    startAgent();
    for (let i = 0; i < 150; i++) {
      apiOrigin = output.match(/API listening on (http:\/\/[^\s]+)/)?.[1];
      if (apiOrigin && output.includes("agent_started")) break;
      if (api.exitCode !== null || agent.exitCode !== null)
        throw Error("fixture startup " + errors);
      await delay(50);
    }
    if (!apiOrigin || !output.includes("agent_started"))
      throw Error("fixture timeout " + errors);
    const call = async (
      path,
      { method = "GET", body, key, status = 200, auth = true } = {},
    ) => {
      const response = await fetch(apiOrigin + path, {
        method,
        headers: {
          ...(auth ? { Authorization: "Bearer " + bearer, ...identity.headers(method, path) } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = response.status === 204 ? null : await response.json();
      if (response.status !== status)
        throw Error(
          `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
        );
      return value;
    };
    return {
      root,
      bearer,
      identity,
      api: apiOrigin,
      agentOrigin: `http://127.0.0.1:${agentPort}`,
      toolOrigin: `http://127.0.0.1:${toolPort}`,
      token,
      taskToken,taskOrigin:`http://127.0.0.1:${taskPort}`,env,
      calls,
      tools,
      config,
      call,
      close,
      async stopAgent(signal = "SIGTERM") {
        agent.kill(signal);
        await new Promise((r) => agent.once("exit", r));
      },
      async restartAgent() {
        output = "";
        startAgent();
        for (let i = 0; i < 100; i++) {
          if (output.includes("agent_started")) return;
          await delay(50);
        }
        throw Error("Agent restart timeout");
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
export async function seedThinkingBook(f) {
  let b = await f.call("/v1/studio/books", {
    method: "POST",
    body: { operation: "create", baseVersion: 0, title: "合成人物关系" },
    key: "create",
    status: 201,
  });
  for (let i = 1; i < 3; i++)
    b = await f.call(`/v1/studio/books/${b.bookId}/structure`, {
      method: "PUT",
      body: { operation: "chapter", baseVersion: b.version },
      key: "chapter-" + i,
    });
  const text = [
    "林舟与父亲发生争执。",
    "林舟发现父亲隐瞒了往事。",
    "父亲为了保护林舟而撒谎。",
  ];
  for (let i = 0; i < 3; i++) {
    const chapter = b.chapters[i].chapterId,
      base = `/v1/projects/${b.bookId}/chapters/${chapter}`,
      head = await f.call(base);
    await f.call(base + "/revisions", {
      method: "POST",
      key: "save-" + i,
      body: { baseRevisionId: head.headRevision.revisionId, markdown: text[i] },
      status: 201,
    });
  }
  return b;
}
