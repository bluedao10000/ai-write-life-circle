import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startKnowledgeFixture } from "./lib/knowledge-fixture.mjs";
let paid = 0;
const remote = createServer(async (req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  for await (const b of req) raw += b;
  const body = JSON.parse(raw);
  assert.equal(req.headers.authorization, "Bearer synthetic-only-budget-test");
  assert.equal(body.max_tokens, 8192);
  paid++;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        {
          message: { content: '{"entities":[],"assertions":[]}' },
          finish_reason: "stop",
        },
      ],
    }),
  );
});
await new Promise((r) => remote.listen(0, "127.0.0.1", r));
const saved = {
  key: process.env.WRITER_AGENT_LLM_API_KEY,
  url: process.env.WRITER_AGENT_LLM_BASE_URL,
  model: process.env.WRITER_AGENT_LLM_MODEL,
};
process.env.WRITER_AGENT_LLM_API_KEY = "synthetic-only-budget-test";
process.env.WRITER_AGENT_LLM_BASE_URL = `http://127.0.0.1:${remote.address().port}`;
process.env.WRITER_AGENT_LLM_MODEL = "fixture";
let fixture;
try {
  fixture = await startKnowledgeFixture({ live: true });
  const body = {
    model: "fixture",
    max_tokens: 99999,
    messages: [
      { role: "system", content: "synthetic" },
      { role: "user", content: JSON.stringify({ targetMarkdown: "合成文字" }) },
    ],
  };
  for (let i = 0; i < 40; i++)
    assert.equal(
      (
        await fetch(fixture.modelOrigin, {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await fetch(fixture.modelOrigin, {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).status,
    429,
  );
  assert.equal(paid, 40);
  console.log(
    "Knowledge synthetic Eval gateway: 40-call hard cap and 8192-output-token clamp passed (local HTTP only).",
  );
} finally {
  await fixture?.close();
  await new Promise((r) => remote.close(r));
  for (const [key, value] of [
    ["WRITER_AGENT_LLM_API_KEY", saved.key],
    ["WRITER_AGENT_LLM_BASE_URL", saved.url],
    ["WRITER_AGENT_LLM_MODEL", saved.model],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
