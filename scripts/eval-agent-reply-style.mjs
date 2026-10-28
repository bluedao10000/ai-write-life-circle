import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  evaluateSamples,
  loadReplyStylePolicy,
} from "./lib/agent-reply-style.mjs";
import {
  seedThinkingBook,
  startThinkingFixture,
} from "./lib/thinking-fixture.mjs";

const defaultInput = fileURLToPath(
  new URL("../harness/evals/agent-reply-style/samples.jsonl", import.meta.url),
);
const live = process.argv.includes("--live");
const checkTargets = process.argv.includes("--check");
if (live && !process.argv.includes("--confirm-fixtures"))
  throw Error(
    "Live style evaluation requires --confirm-fixtures; only synthetic novel contexts are sent",
  );

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const inputPath = resolve(argument("--input", defaultInput));
if (live && inputPath !== resolve(defaultInput))
  throw Error("Live style evaluation only accepts the checked-in synthetic corpus");
const outputPath = resolve(
  argument(
    "--output",
    `.local/evals/agent-reply-style/${live ? "live" : "offline"}-report.json`,
  ),
);

async function readJsonl(path) {
  const source = await readFile(path, "utf8");
  return source
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim())
    .map(({ line, number }) => {
      let sample;
      try {
        sample = JSON.parse(line);
      } catch (error) {
        throw Error(`Invalid JSONL at line ${number}: ${error.message}`);
      }
      if (!sample.id || !["default", "extended"].includes(sample.kind))
        throw Error(`Sample at line ${number} requires id and default/extended kind`);
      if (!sample.question || typeof sample.response !== "string")
        throw Error(`Sample at line ${number} requires question and response`);
      return sample;
    });
}

async function collectLiveReplies(samples) {
  const fixture = await startThinkingFixture({ live: true, maxOutputTokens: "4096" });
  try {
    const book = await seedThinkingBook(fixture);
    const base = `/v1/studio/books/${book.bookId}/thinking`;
    const model = await fixture.call(base + "/capabilities");
    const replies = [];
    for (const sample of samples) {
      const session = await fixture.call(base + "/sessions", {
        method: "POST",
        status: 201,
        key: `style-${sample.id}-session`,
        body: { consent: true, model, scopes: [] },
      });
      const path = `${base}/sessions/${session.sessionId}`;
      await fixture.call(path + "/messages", {
        method: "POST",
        status: 202,
        key: `style-${sample.id}-message`,
        body: { text: sample.question },
      });
      let result;
      for (let attempt = 0; attempt < 2400; attempt++) {
        result = await fixture.call(path);
        if (result.status === "idle") break;
        await delay(50);
      }
      const answer = result?.messages.at(-1);
      if (result?.status !== "idle" || answer?.status !== "completed")
        throw Error(`Live style evaluation failed for ${sample.id}`);
      replies.push({
        id: sample.id,
        kind: sample.kind,
        scenario: sample.scenario,
        source: "live-model-synthetic-context",
        question: sample.question,
        response: answer.text,
      });
    }
    const modelId =
      typeof model === "string" ? model : (model.modelId ?? model.model ?? "unknown");
    return { modelId, replies };
  } finally {
    await fixture.close();
  }
}

const policy = await loadReplyStylePolicy();
const fixtures = await readJsonl(inputPath);
if (live && fixtures.some((sample) => sample.source !== "human-authored-synthetic"))
  throw Error("Live style evaluation requires verified synthetic fixture provenance");
const liveResult = live ? await collectLiveReplies(fixtures) : null;
const samples = liveResult?.replies ?? fixtures;
const synthetic = samples.every((sample) =>
  ["human-authored-synthetic", "live-model-synthetic-context"].includes(sample.source),
);
const modelId = liveResult?.modelId ?? argument("--model-id", "offline-jsonl-not-a-model");
const evaluation = evaluateSamples(samples, policy);
const report = {
  schema: 1,
  policyId: policy.policy_id,
  policyVersion: policy.policy_version,
  modelId,
  mode: live ? "live-model" : "offline-jsonl",
  synthetic,
  realLLMCalled: live,
  qualityValidated: false,
  at: new Date().toISOString(),
  sampleCount: samples.length,
  defaultSampleCount: samples.filter((sample) => sample.kind === "default").length,
  extendedSampleCount: samples.filter((sample) => sample.kind === "extended").length,
  targets: {
    forbiddenPhraseHitRate: policy.metric_targets.forbidden_phrase_hit_rate,
    averageVisibleCharacters: policy.metric_targets.average_visible_characters,
    defaultLengthPassRate: policy.metric_targets.default_length_pass_rate,
    manualPracticalityPassRate: policy.metric_targets.manual_practicality_pass_rate,
  },
  ...evaluation,
  manualReviewRequired: true,
  manualReview: [
    "具体创作洞察与文学判断力",
    "剧情信息、世界规则和不确定性是否准确保留",
    "引文与来源是否支持结论",
    "明确要求的深入分析是否完整交付",
  ],
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(
  JSON.stringify({
    report: outputPath,
    policyVersion: report.policyVersion,
    modelId: report.modelId,
    realLLMCalled: report.realLLMCalled,
    sampleCount: report.sampleCount,
    metrics: report.metrics,
    automaticTargetsPassed: report.automaticTargetsPassed,
    manualReviewRequired: report.manualReviewRequired,
  }),
);
if (checkTargets && !report.automaticTargetsPassed)
  throw Error("RAS-001 automatic evaluation targets failed; inspect the report");
