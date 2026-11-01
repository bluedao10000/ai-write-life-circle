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
  hasConclusionFirst,
  loadReplyStylePolicy,
  restatementOverlap,
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
  assert.deepEqual(
    findForbiddenPhrases("沈照守灵体现了人物弧光，充满戏剧张力。", policy.forbidden_phrases),
    ["体现了", "戏剧张力", "人物弧光"],
  );
  assert.deepEqual(
    findForbiddenPhrases("这一幕折射出判断体系的伦理代价。", policy.forbidden_phrases),
    ["折射出", "判断体系", "伦理代价"],
  );
  assert.deepEqual(
    findForbiddenPhrases("让他把火石收走，读者就看得出他在防人。", policy.forbidden_phrases),
    [],
  );
});

test("conclusion-first accepts a direct situation or action without a marker word", () => {
  const options = {
    fillers: policy.opening_fillers,
    forbiddenPhrases: policy.forbidden_phrases,
    question: "沈照明明恨父亲，为什么还替他守灵？",
    restatementThreshold: policy.restatement_overlap,
  };
  const check = (text) => hasConclusionFirst(text, policy.conclusion_markers, options);
  assert.equal(check("他得守。缺席等于告诉众人，这些年的反抗只是赌气。"), true);
  assert.equal(check("灵堂里只有他一个人跪到天亮。"), true);
  assert.equal(check("说得通，沈照替父亲守灵是在给自己作证。"), true);
  assert.equal(check("好的，我们来看沈照。他得守。"), false, "pleasantry opening");
  assert.equal(check("首先要看沈照的处境。"), false, "warm-up opening");
  assert.equal(check("你提到沈照恨父亲。他还是得守。"), false, "restating the author");
  assert.equal(check("沈照明明恨父亲，为什么还替他守灵。因为他得守。"), false, "restated question");
  assert.equal(check("谁会在仇人灵前跪三夜？他会。"), false, "opening with a question");
  assert.equal(check("沈照的守灵体现了人物的复杂。"), false, "canned critique");
  assert.equal(check("  \n"), false);
  assert(restatementOverlap("沈照明明恨父亲，为什么还替他守灵", options.question) >= 0.99);
  assert.equal(restatementOverlap("他得守", ""), 0);
});

test("offline samples avoid the 'not A but B' aphorism and criticism jargon", () => {
  for (const sample of samples) {
    assert.doesNotMatch(sample.response, /不是[^。！？；\n]*而是/, sample.id);
    assert.doesNotMatch(sample.response, /关键在于/, sample.id);
    assert.doesNotMatch(sample.response, /弧光|张力|维度|机制|折射|体现/, sample.id);
  }
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
  assert.equal(report.metrics.conclusionFirstRate, 1);
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
  const asLiteral = (text) => JSON.stringify(text.trim()).slice(1, -1);
  assert(generated.includes(asLiteral(policy.runtime_instruction)));
  assert(generated.includes(asLiteral(policy.fidelity_instruction)));
  const numeric = policy.default_reply;
  const instruction = buildReplyStyleInstruction(policy);
  assert(
    instruction.indexOf(policy.runtime_instruction.trim()) <
      instruction.indexOf(policy.fidelity_instruction.trim()),
  );
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
