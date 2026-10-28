import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeReply,
  countVisibleCharacters,
  estimateSentenceCount,
  evaluateSamples,
  findForbiddenPhrases,
  loadReplyStylePolicy,
} from "./lib/agent-reply-style.mjs";

const policy = await loadReplyStylePolicy();
const samples = (await readFile("harness/evals/agent-reply-style/samples.jsonl", "utf8"))
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));

test("RAS-001 eval reads the same policy and has 60 default plus 15 extended samples", () => {
  assert.equal(policy.policy_id, "RAS-001");
  assert.equal(samples.filter((sample) => sample.kind === "default").length, 60);
  assert.equal(samples.filter((sample) => sample.kind === "extended").length, 15);
  assert(samples.every((sample) => sample.source === "human-authored-synthetic"));
});

test("forbidden phrase detection finds canned prose without matching unrelated text", () => {
  assert.deepEqual(
    findForbiddenPhrases("综上所述，这只是建议。", policy.forbidden_phrases),
    ["综上所述"],
  );
  assert.deepEqual(
    findForbiddenPhrases("关键在于他仍想保护家人。", policy.forbidden_phrases),
    [],
  );
  assert.deepEqual(
    findForbiddenPhrases("作为一个AI，我不能回答", policy.forbidden_phrases),
    ["作为一个AI"],
  );
});

test("visible character counting strips markup, citations and whitespace but counts Unicode code points", () => {
  assert.equal(
    countVisibleCharacters(" **关键**[[source:ch-1]]\n- 在于选择 👨‍👩‍👧"),
    Array.from("关键在于选择👨‍👩‍👧").length,
  );
  assert.equal(countVisibleCharacters("[结论](https://example.invalid) `成立`。"), 5);
});

test("sentence estimation handles Chinese punctuation, newlines and a final unpunctuated sentence", () => {
  assert.equal(estimateSentenceCount("关键在于选择。他仍会回去。"), 2);
  assert.equal(estimateSentenceCount("第一行\n第二行！\n最后没有标点"), 3);
  assert.equal(estimateSentenceCount("  \n"), 0);
});

test("ordinary length violations do not compress explicitly extended analysis", () => {
  const longResponse = "关键在于保留证据。".repeat(30);
  const ordinary = analyzeReply(
    { id: "ordinary", kind: "default", response: longResponse },
    policy,
  );
  const extended = analyzeReply(
    { id: "extended", kind: "extended", response: longResponse },
    policy,
  );
  assert(ordinary.violations.includes("default_length"));
  assert(ordinary.violations.includes("default_sentence_count"));
  assert(!extended.violations.includes("default_length"));
  assert(!extended.violations.includes("default_sentence_count"));
});

test("offline baseline meets automatic targets without claiming manual or real-model quality", () => {
  const report = evaluateSamples(samples, policy);
  assert.equal(report.automaticTargetsPassed, true, JSON.stringify(report.violationExamples));
  assert.equal(report.metrics.forbiddenPhraseHitRate, 0);
  assert(report.metrics.defaultLengthPassRate >= 0.9);
  assert(report.metrics.averageVisibleCharacters <= 150);
  assert.equal(report.metrics.manualPracticalityPassRate, null);
});

test("negative fixtures fail forbidden phrase and ordinary length gates", () => {
  const report = evaluateSamples(
    [
      { id: "bad", kind: "default", response: "综上所述。".repeat(50) },
      ...samples,
    ],
    policy,
  );
  assert(report.metrics.forbiddenPhraseHitRate > 0);
  assert(report.violationExamples.some((example) => example.id === "bad"));
});

test("generated TypeScript carries the same policy version and forbidden phrases", async () => {
  const generated = await readFile(
    "apps/agent/src/agents/thinking/reply-style.generated.ts",
    "utf8",
  );
  assert(generated.includes(`"version": "${policy.policy_version}"`));
  for (const phrase of policy.forbidden_phrases)
    assert(generated.includes(JSON.stringify(phrase)));
  assert(generated.includes(policy.runtime_instruction.trim()));
});
