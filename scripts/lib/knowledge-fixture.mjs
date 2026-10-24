import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {randomBytes} from "node:crypto";
import {createServer as tcpServer} from "node:net";
import { spawn, spawnSync } from "node:child_process";
// Authored HTTP fixture; never a measurement of model intelligence.
export function syntheticOutput(input) {
  const text = input.targetMarkdown,
    entities = [],
    assertions = [];
  for (const [name, type] of [
    ["林舟", "character"],
    ["阿宁", "character"],
    ["灰衣客", "character"],
    ["父亲", "character"],
    ["北港", "place"],
    ["江宁", "place"],
    ["铜铃", "foreshadowing"],
  ]) {
    if (!text.includes(name)) continue;
    const existing = input.existingEntities?.find(
      (e) => e.type === type && (e.name === name || e.aliases.includes(name)),
    );
    const key = "e" + entities.length;
    entities.push({
      key,
      type,
      name,
      aliases: [],
      identity: "",
      ...(existing ? { existingEntityId: existing.entityId } : {}),
    });
    assertions.push({
      entityKey: key,
      predicate: "原文观察",
      text,
      epistemic:
        type === "foreshadowing"
          ? "inference"
          : text.includes("说") || text.includes("以为")
            ? "claim"
            : "observation",
      sourceKind: text.includes("说")
        ? "dialogue"
        : text.includes("以为")
          ? "thought"
          : "narration",
      quote: text,
    });
  }
  return { entities, assertions };
}
export async function startKnowledgeFixture({
  live = false,
  pi = false,
  apiPort = 0,
} = {}) {
  if(pi&&live)throw Error("Use the separately bounded Pi live Eval runner");
  const root = await mkdtemp(join(tmpdir(), "story2u-memory-fixture-"));
  await mkdir(join(root, "harness"));
  await mkdir(join(root,"state"));
  let calls = 0,
    inputBytes = 0,
    budgetBlocked = false;
  const remote = live
    ? new URL(
        process.env.WRITER_AGENT_LLM_BASE_URL || "https://api.deepseek.com",
      )
    : null;
  if (
    remote &&
    (remote.username ||
      remote.password ||
      remote.search ||
      remote.hash ||
      (remote.protocol !== "https:" &&
        !(
          remote.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(remote.hostname)
        )))
  )
    throw Error("Invalid synthetic Eval model origin");
  const maxCalls = Number(
      process.env.WRITER_AGENT_KNOWLEDGE_EVAL_MAX_CALLS || 40,
    ),
    maxInputBytes = Number(
      process.env.WRITER_AGENT_KNOWLEDGE_EVAL_MAX_INPUT_BYTES || 1024 * 1024,
    ),
    maxOutputTokens = 8192;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 40)
    throw Error("Invalid Eval call cap");
  if (
    !Number.isInteger(maxInputBytes) ||
    maxInputBytes < 1 ||
    maxInputBytes > 1024 * 1024
  )
    throw Error("Invalid Eval input cap");
  const model = createServer(async (req, res) => {
    req.setEncoding("utf8");
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 64000) {
        res.writeHead(413);
        res.end("{}");
        return;
      }
    }
    try {
      const body = JSON.parse(raw);
      const input = JSON.parse(body.messages[1].content);
      if (live) {
        if (
          calls >= maxCalls ||
          inputBytes + Buffer.byteLength(raw) > maxInputBytes
        ) {
          budgetBlocked = true;
          res.writeHead(429);
          res.end("{}");
          return;
        }
        calls++;
        inputBytes += Buffer.byteLength(raw);
        for (const key of ["max_tokens", "max_completion_tokens"])
          if (body[key] !== undefined)
            body[key] = Math.min(body[key], maxOutputTokens);
        const endpoint = new URL(remote);
        endpoint.pathname =
          endpoint.pathname.replace(/\/$/, "") + "/chat/completions";
        const upstream = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + process.env.WRITER_AGENT_LLM_API_KEY,
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(180000),
        });
        const chunks = [];
        let size = 0;
        const reader = upstream.body?.getReader();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 256 * 1024) {
              await reader.cancel();
              res.writeHead(502);
              res.end("{}");
              return;
            }
            chunks.push(Buffer.from(value));
          }
        }
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(Buffer.concat(chunks));
        return;
      }
      calls++;
      if(body.stream){res.writeHead(200,{"content-type":"text/event-stream"});res.end('data: '+JSON.stringify({id:'knowledge',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{role:'assistant',content:JSON.stringify(syntheticOutput(input))},finish_reason:'stop'}],usage:{prompt_tokens:150,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');return}
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify(syntheticOutput(input)) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 100 },
        }),
      );
    } catch {
      res.writeHead(502);
      res.end("{}");
    }
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const modelOrigin = `http://127.0.0.1:${model.address().port}`;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith("WRITER_AGENT_"))),
    NODE_ENV: "test",
    WRITER_AGENT_ENV: "test",
    WRITER_AGENT_AUTH_MODE: "local",
    WRITER_AGENT_PROJECT_ID: "synthetic-memory",
    WRITER_AGENT_API_HOST: "127.0.0.1",
    WRITER_AGENT_API_PORT: String(apiPort),
    WRITER_AGENT_HARNESS_ROOT: join(root, "harness"),
    WRITER_AGENT_STATE_DIR: join(root, "state"),
    ...{
      WRITER_AGENT_LLM_PROVIDER: "openai-compatible",
      WRITER_AGENT_LLM_BASE_URL: modelOrigin,
      WRITER_AGENT_LLM_API_KEY: "",
      WRITER_AGENT_LLM_MODEL: live
        ? process.env.WRITER_AGENT_LLM_MODEL || "deepseek-flash"
        : "knowledge-http-fixture",
      WRITER_AGENT_LLM_RESPONSE_FORMAT: "json_object",
      WRITER_AGENT_LLM_TOKEN_PARAMETER: "max_tokens",
      WRITER_AGENT_LLM_TIMEOUT_SECONDS: live ? "180" : "2",
      WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS: "8192",
    },
  };
  if(pi){const port=tcpServer();await new Promise(r=>port.listen(0,'127.0.0.1',r));const address=port.address().port;await new Promise(r=>port.close(r));const token=join(root,'task.token');await writeFile(token,randomBytes(32).toString('hex'),{mode:0o600});Object.assign(env,{WRITER_AGENT_TASK_SERVICE_TOKEN_FILE:token,WRITER_AGENT_TASK_INTERNAL_PORT:String(address),WRITER_AGENT_TASK_ORIGIN:`http://127.0.0.1:${address}`,WRITER_AGENT_PI_WORKER_FIXTURE:'1'})}
  let error = "";
  const child = spawn(
    new URL("../../apps/api-go/dist/writer-agent-api", import.meta.url)
      .pathname,
    [],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.on("data", (d) => {
    error += d;
  });
  let worker;
  if(!pi){worker = spawn(new URL('../../apps/api-go/dist/writer-agent-worker', import.meta.url).pathname, [], { env, stdio: ['ignore','ignore','pipe'] });
  worker.stderr.on('data', d => { error += d });}
  let api;
  try {
    api = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(Error("Fixture API startup timeout: " + error)),
        15000,
      );
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("Fixture API stopped: " + error));
      });
      child.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/listening on http:\/\/(127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve("http://" + m[1]);
        }
      });
    });
  } catch (e) {
    child.kill("SIGTERM");
    model.close();
    await rm(root, { recursive: true, force: true });
    throw e;
  }
  if(pi){const c=spawnSync(new URL('../../apps/api-go/dist/writer-agent-control',import.meta.url).pathname,['--state',join(root,'state'),'--kind','knowledge','--owner','pi'],{encoding:'utf8'});if(c.status!==0)throw Error(c.stderr);worker=spawn(process.execPath,[new URL('../../apps/agent/dist/worker/main.js',import.meta.url).pathname],{env:{...env,WRITER_AGENT_LLM_API_KEY:'synthetic-only'},stdio:['ignore','ignore','pipe']});worker.stderr.on('data',d=>{error+=d})}
  return {
    api,
    modelOrigin,
    root,
    remoteModelOrigin: remote?.origin,
    maxCalls,
    maxInputBytes,
    maxOutputTokens,
    get budgetBlocked() {
      return budgetBlocked;
    },
    get inputBytes() {
      return inputBytes;
    },
    get calls() {
      return calls;
    },
    async close() {
      worker.kill("SIGTERM");
      await new Promise(r => { if(worker.exitCode !== null || worker.signalCode !== null) r(); else worker.once("exit",r) });
      child.kill("SIGTERM");
      await new Promise((r) => {
        if (child.exitCode !== null) r();
        else child.once("exit", r);
      });
      await new Promise((r) => model.close(r));
      await rm(root, { recursive: true, force: true });
    },
  };
}
