import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  evaluateSamples,
  loadReplyStylePolicy,
} from "./lib/agent-reply-style.mjs";
import {
  assertLiveBudget,
  corpusDigest,
  liveBudgetError,
  liveUsageTotals,
  selectLiveFixtures,
} from "./lib/agent-reply-style-live.mjs";
import {
  seedThinkingBook,
  startThinkingFixture,
} from "./lib/thinking-fixture.mjs";

const defaultInput = fileURLToPath(
  new URL("../harness/evals/agent-reply-style/samples.jsonl", import.meta.url),
);
const live = process.argv.includes("--live");
const localHttpSmoke = live && process.env.RAS_001_LOCAL_HTTP_SMOKE === "1";
const full = process.argv.includes("--full");
const checkTargets = process.argv.includes("--check");
if (live && !process.argv.includes("--confirm-fixtures"))
  throw Error(
    "Live style evaluation requires --confirm-fixtures; only synthetic novel contexts are sent",
  );

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= process.argv.length || process.argv[index + 1].startsWith("--"))
    throw Error(`${name} requires a value`);
  return process.argv[index + 1];
};
const positiveInteger = (name, fallback) => {
  const value = Number(argument(name, fallback));
  if (!Number.isSafeInteger(value) || value < 1)
    throw Error(`${name} requires a positive integer`);
  return value;
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
if (localHttpSmoke && !process.argv.includes("--output"))
  throw Error("Local HTTP transport tests require a separate --output path");
const checkpointPath = resolve(
  argument(
    "--checkpoint",
    outputPath.replace(/\.json$/i, "") + ".checkpoint.json",
  ),
);
const maxCalls = positiveInteger("--max-calls", full ? 75 : 10);
const maxTotalTokens = positiveInteger("--max-total-tokens", full ? 450000 : 60000);
const maxOutputTokens = positiveInteger("--max-output-tokens", 4096);
if (maxOutputTokens < 128 || maxOutputTokens > 8192)
  throw Error("--max-output-tokens must be between 128 and 8192");
const resume = process.argv.includes("--resume");
if (!live && resume) throw Error("--resume is only supported for live evaluation");

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

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function collectLiveReplies(fixtures, digest) {
  let state = {
    schema: 1,
    corpusSha256: digest,
    full,
    maxCalls,
    maxTotalTokens,
    maxOutputTokens,
    replies: [],
    failures: [],
    pending: [],
  };
  if (resume) {
    state = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (
      state.schema !== 1 ||
      state.corpusSha256 !== digest ||
      state.full !== full ||
      state.maxCalls !== maxCalls ||
      state.maxTotalTokens !== maxTotalTokens ||
      state.maxOutputTokens !== maxOutputTokens ||
      !Array.isArray(state.replies) ||
      !Array.isArray(state.failures) ||
      !Array.isArray(state.pending) ||
      state.replies.some((reply) => !fixtures.some((sample) => sample.id === reply.id))
    )
      throw Error("RAS-001 checkpoint does not match this corpus, selection or budget limits");
    const ids = state.replies.map((reply) => reply.id);
    if (new Set(ids).size !== ids.length)
      throw Error("RAS-001 checkpoint contains duplicate completed samples");
    state.pending = [];
  }
  const checkpoint = async (extra = {}) => {
    await atomicWriteJson(checkpointPath, {
      ...state,
      ...extra,
      updatedAt: new Date().toISOString(),
      usage: liveUsageTotals(
        [...state.replies, ...state.failures],
        maxOutputTokens,
      ),
    });
  };
  await checkpoint();
  const fixture = await startThinkingFixture({
    live: true,
    maxOutputTokens,
    allowLocalLiveTransport: localHttpSmoke,
  });
  try {
    const book = await seedThinkingBook(fixture);
    const base = `/v1/studio/books/${book.bookId}/thinking`;
    const model = await fixture.call(base + "/capabilities");
    for (const sample of fixtures) {
      if (
        state.replies.some((reply) => reply.id === sample.id) ||
        state.failures.some((failure) => failure.id === sample.id)
      ) {
        console.error(`RAS-001 live: resume ${sample.id}`);
        continue;
      }
      try {
        const totals = assertLiveBudget({
          replies: state.replies,
          failures: state.failures,
          maxCalls,
          maxTotalTokens,
          maxOutputTokens,
        });
        if (totals.budgetTokens + maxOutputTokens > maxTotalTokens)
          throw liveBudgetError(
            "RAS-001 live token budget cannot cover the next sample's output reservation",
          );
      } catch (error) {
        if (error.name !== "LiveBudgetError") throw error;
        state.pending = fixtures
          .filter(
            (fixture) =>
              !state.replies.some((reply) => reply.id === fixture.id) &&
              !state.failures.some((failure) => failure.id === fixture.id),
          )
          .map((sample) => sample.id);
        await checkpoint({ stopReason: error.message });
        console.error(error.message);
        break;
      }
      let result;
      let answer;
      try {
        console.error(`RAS-001 live: ${sample.id}`);
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
        for (let attempt = 0; attempt < 2400; attempt++) {
          result = await fixture.call(path);
          if (result.status === "idle") break;
          await delay(50);
        }
        answer = result?.messages.at(-1);
        if (result?.status !== "idle" || answer?.status !== "completed")
          throw Error(answer?.errorCode ?? "LIVE_EVAL_TIMEOUT");
        state.replies.push({
          id: sample.id,
          kind: sample.kind,
          scenario: sample.scenario,
          source: "live-model-synthetic-context",
          question: sample.question,
          response: answer.text,
          usage: result.usage,
        });
        await checkpoint();
      } catch (error) {
        state.failures.push({
          id: sample.id,
          at: new Date().toISOString(),
          code: error.message,
          usage: result?.usage ?? null,
          response: answer?.text ?? "",
        });
        await checkpoint();
        throw Error(`Live style evaluation failed for ${sample.id}; checkpoint saved`);
      }
    }
    const modelId =
      typeof model === "string" ? model : (model.modelId ?? model.model ?? "unknown");
    return { modelId, ...state };
  } finally {
    await fixture.close();
  }
}

const policy = await loadReplyStylePolicy();
const allFixtures = await readJsonl(inputPath);
if (live && allFixtures.some((sample) => sample.source !== "human-authored-synthetic"))
  throw Error("Live style evaluation requires verified synthetic fixture provenance");
const fixtures = live ? selectLiveFixtures(allFixtures, full) : allFixtures;
const digest = live ? corpusDigest(fixtures) : null;
const liveResult = live ? await collectLiveReplies(fixtures, digest) : null;
const samples = liveResult?.replies ?? fixtures;
const synthetic = samples.every((sample) =>
  ["human-authored-synthetic", "live-model-synthetic-context"].includes(sample.source),
);
const modelId = liveResult?.modelId ?? argument("--model-id", "offline-jsonl-not-a-model");
const evaluation = evaluateSamples(samples, policy);
const complete =
  !live ||
  (samples.length === fixtures.length && liveResult.failures.length === 0);
const report = {
  schema: 2,
  policyId: policy.policy_id,
  policyVersion: policy.policy_version,
  modelId,
  mode: live ? (localHttpSmoke ? "local-http-engineering" : "live-model") : "offline-jsonl",
  synthetic,
  realLLMCalled: live && !localHttpSmoke,
  qualityValidated: false,
  at: new Date().toISOString(),
  complete,
  selection: live ? (full ? "full" : "fixed-smoke-10") : "input",
  sampleCount: samples.length,
  selectedSampleCount: fixtures.length,
  defaultSampleCount: samples.filter((sample) => sample.kind === "default").length,
  extendedSampleCount: samples.filter((sample) => sample.kind === "extended").length,
  targets: {
    forbiddenPhraseHitRate: policy.metric_targets.forbidden_phrase_hit_rate,
    defaultAverageVisibleCharacters:
      policy.metric_targets.default_average_visible_characters,
    defaultLengthPassRate: policy.metric_targets.default_length_pass_rate,
    manualPracticalityPassRate: policy.metric_targets.manual_practicality_pass_rate,
  },
  ...evaluation,
  ...(live
    ? {
        liveBudget: {
          maxCalls,
          maxTotalTokens,
          maxOutputTokens,
          completedSampleCalls: samples.length,
          failedSampleCalls: liveResult.failures.length,
          ...liveUsageTotals(
            [...samples, ...liveResult.failures],
            maxOutputTokens,
          ),
          checkpoint: checkpointPath,
          resumed: resume,
          localHttpSmoke,
        },
        failures: liveResult.failures,
        pendingSampleIds: liveResult.pending,
      }
    : {}),
  manualReviewRequired: true,
  manualReview: [
    "具体创作洞察与文学判断力",
    "剧情信息、世界规则和不确定性是否准确保留",
    "引文与来源是否支持结论",
    "明确要求的深入分析是否完整交付",
    "结论先行与套话指标需人工标注校准，不能只依赖关键词近似值",
  ],
};
await atomicWriteJson(outputPath, report);
console.log(
  JSON.stringify({
    report: outputPath,
    policyVersion: report.policyVersion,
    modelId: report.modelId,
    realLLMCalled: report.realLLMCalled,
    complete: report.complete,
    sampleCount: report.sampleCount,
    metrics: report.metrics,
    automaticTargetsPassed: report.automaticTargetsPassed,
    manualReviewRequired: report.manualReviewRequired,
  }),
);
if (checkTargets && (!report.complete || !report.automaticTargetsPassed))
  throw Error("RAS-001 automatic evaluation targets failed; inspect the report");
