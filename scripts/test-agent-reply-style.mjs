import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeReply,
  buildReplyStyleInstruction,
  countVisibleCharacters,
  estimateSentenceCount,
  evaluateSamples,
  findForbiddenPhrases,
  loadReplyStylePolicy,
} from "./lib/agent-reply-style.mjs";
import {
  assertLiveBudget,
  corpusDigest,
  liveUsageTotals,
  selectLiveFixtures,
} from "./lib/agent-reply-style-live.mjs";

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
  assert.deepEqual(
    findForbiddenPhrases("下面我从几个方面分析这个设定。", policy.forbidden_phrases),
    ["下面我从几个方面分析"],
  );
  assert.deepEqual(
    findForbiddenPhrases("关键在于从人物动机而非句式判断。", policy.forbidden_phrases),
    [],
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
  assert(report.metrics.defaultAverageVisibleCharacters <= 150);
  assert(report.metrics.extendedAverageVisibleCharacters > 180);
  assert.equal(report.metrics.manualPracticalityPassRate, null);
});

test("extended analysis length never weakens or fails the ordinary average gate", () => {
  const defaults = samples.filter((sample) => sample.kind === "default");
  const ordinary = evaluateSamples(defaults, policy);
  const withLongAnalysis = evaluateSamples(
    [
      ...defaults,
      { id: "long", kind: "extended", response: "需要完整保留推演。".repeat(10000) },
    ],
    policy,
  );
  assert.equal(
    withLongAnalysis.metrics.defaultAverageVisibleCharacters,
    ordinary.metrics.defaultAverageVisibleCharacters,
  );
  assert.equal(withLongAnalysis.automaticTargetsPassed, true);
  assert.equal(
    evaluateSamples(
      [{ id: "extended", kind: "extended", response: "需要完整分析。" }],
      policy,
    ).automaticTargetsPassed,
    false,
    "an extended-only report must not claim that the ordinary gate passed",
  );
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
  const numeric = policy.default_reply;
  const instruction = buildReplyStyleInstruction(policy);
  assert(instruction.includes(`normally ${numeric.min_sentences}-${numeric.max_sentences} sentences`));
  assert(instruction.includes(`at most ${numeric.max_visible_characters} visible characters`));
  assert(!policy.runtime_instruction.includes(String(numeric.max_visible_characters)));
  assert(generated.includes(JSON.stringify(instruction)));
});

test("live smoke selection is fixed, representative and defaults to ten samples", () => {
  const selected = selectLiveFixtures(samples);
  assert.equal(selected.length, 10);
  assert.equal(selected.filter((sample) => sample.kind === "default").length, 8);
  assert.equal(selected.filter((sample) => sample.kind === "extended").length, 2);
  assert.equal(new Set(selected.map((sample) => sample.scenario)).size, 4);
  assert.deepEqual(selected, selectLiveFixtures(samples));
  assert.equal(selectLiveFixtures(samples, true).length, 75);
  assert.notEqual(corpusDigest(selected), corpusDigest(samples));
});

test("live call and token budgets stop before another paid request and include failures", () => {
  const reply = {
    usage: { input: 1000, output: 200, charged: 8000, incomplete: false },
  };
  const failure = {
    usage: { input: 1000, output: 100, charged: 7000, incomplete: true },
  };
  const usage = liveUsageTotals([reply, failure], 4096);
  assert.equal(usage.budgetTokens, 8200);
  assert.equal(usage.reportedOutputTokens, 300);
  assert.throws(
    () => assertLiveBudget({ replies: [reply], maxCalls: 1, maxTotalTokens: 60000, maxOutputTokens: 4096 }),
    /call budget exhausted/,
  );
  assert.throws(
    () => assertLiveBudget({ replies: [reply], failures: [failure], maxCalls: 2, maxTotalTokens: 60000, maxOutputTokens: 4096 }),
    /call budget exhausted/,
  );
  assert.throws(
    () => assertLiveBudget({ replies: [reply], maxCalls: 2, maxTotalTokens: 1200, maxOutputTokens: 4096 }),
    /token budget exhausted/,
  );
  assert.throws(
    () => assertLiveBudget({ replies: [{ usage: null }], maxCalls: 2, maxTotalTokens: 60000, maxOutputTokens: 4096 }),
    /usage unknown/,
  );
});
