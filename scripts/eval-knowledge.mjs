import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { startKnowledgeFixture } from "./lib/knowledge-fixture.mjs";
const live = process.argv.includes("--live");
if (live && !process.argv.includes("--confirm-fixtures"))
  throw Error("Synthetic material authorization required: --confirm-fixtures");
if (
  live &&
  !process.env.WRITER_AGENT_LLM_API_KEY &&
  !process.env.WRITER_AGENT_LLM_BASE_URL
)
  throw Error(
    "Configure a model locally or use the synthetic GitHub Actions Eval workflow; never put a key in chat.",
  );
const fixture = await startKnowledgeFixture({ live, pi:process.argv.includes("--pi") });
const cases = JSON.parse(
  await readFile(
    new URL("../harness/evals/knowledge/cases.json", import.meta.url),
    "utf8",
  ),
);
const results = [];
const output = process.env.WRITER_AGENT_KNOWLEDGE_EVAL_OUTPUT;
const checkpoint = async () => {
  if (output)
    await writeFile(
      output,
      JSON.stringify(
        {
          mode: live ? "real-model-synthetic-eval" : "http-mock-engineering",
          partial: true,
          cases: results.length,
          modelCalls: fixture.calls,
          qualityValidated: false,
          results,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
};
const call = async (path, method = "GET", body) => {
  const r = await fetch(fixture.api + path, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = await r.json();
  assert.ok(r.ok, JSON.stringify(value));
  return value;
};
const exhausted = () =>
  fixture.budgetBlocked || fixture.calls >= fixture.maxCalls;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function awaitJob(root, chapter, excludeRevision) {
  for (let i = 0; i < (live ? 900 : 200); i++) {
    const jobs = await call(root + "/jobs");
    const job = jobs.items.find(
      (j) => j.chapterId === chapter && j.revisionId !== excludeRevision,
    );
    if (
      exhausted() &&
      (!job || job.status !== "running") &&
      job?.status !== "completed"
    )
      return {
        ...(job ?? { status: "not_run_budget", attempts: 0, durationMs: 0 }),
        budgetStopped: true,
      };
    if (job && ["completed", "failed"].includes(job.status)) return job;
    await sleep(live ? 1000 : 100);
  }
  throw Error("Knowledge job timeout");
}
try {
  for (const item of cases) {
    console.error("Knowledge Eval:", item.id);
    if (exhausted()) {
      results.push({
        id: item.id,
        execution: "not_run_budget",
        remoteCalls: 0,
        engineeringJobs: [],
        entityPrecision: null,
        entityRecall: null,
        relationPrecision: null,
        evidenceValidity: null,
        entityDedupAccuracy: null,
        revisionUpdateAccuracy: null,
        unsupportedAssertionRate: null,
        staleKnowledgeRate: null,
        humanSemanticReview: "not run",
      });
      await checkpoint();
      continue;
    }
    const callsBefore = fixture.calls;
    const b = await call("/v1/studio/books", "POST", {
      operation: "create",
      baseVersion: 0,
      title: "合成评测 " + item.id,
    });
    const root = `/v1/studio/books/${b.bookId}/knowledge`;
    let page = await call(root);
    await call(root + "/enable", "POST", {
      baseVersion: page.version,
      consent: true,
      model: page.model,
      dailyTokenBudget: 1000000,
      dailyJobBudget: 20,
    });
    let book = b;
    const runs = [];
    const started = Date.now();
    for (let index = 0; index < item.chapters.length; index++) {
      if (index)
        book = await call(`/v1/studio/books/${book.bookId}/structure`, "PUT", {
          operation: "chapter",
          baseVersion: book.version,
        });
      const id = book.chapters[index].chapterId;
      const path = `/v1/projects/${book.bookId}/chapters/${id}`;
      let detail = await call(path);
      if (item.chapters[index]) {
        await call(path + "/revisions", "POST", {
          baseRevisionId: detail.headRevision.revisionId,
          markdown: item.chapters[index],
        });
        runs.push(await awaitJob(root, id));
      }
    }
    if (item.replacement) {
      const id = book.chapters[0].chapterId,
        path = `/v1/projects/${book.bookId}/chapters/${id}`;
      const detail = await call(path);
      await call(path + "/revisions", "POST", {
        baseRevisionId: detail.headRevision.revisionId,
        markdown: item.replacement,
      });
      runs.push(await awaitJob(root, id, detail.headRevision.revisionId));
    }
    if (item.rebuild) {
      page = await call(root);
      await call(root + "/rebuild", "POST", { baseVersion: page.version });
      await sleep(live ? 3000 : 1200);
      runs.push(await awaitJob(root, book.chapters[0].chapterId));
    }
    page = await call(root + "?limit=100");
    const active = page.entities.filter((e) => e.status !== "stale"),
      names = new Set(active.flatMap((e) => [e.name, ...e.aliases]));
    const correct = active.filter((e) =>
      item.goldEntityNames.some((n) => n === e.name || e.aliases.includes(n)),
    ).length;
    const current = page.assertions.filter((a) => a.status === "current");
    const sources = current.flatMap((a) =>
      a.sources.filter((s) => s.validity === "current"),
    );
    const budgetStopped = runs.some((r) => r.budgetStopped);
    const row = {
      id: item.id,
      execution: budgetStopped
        ? "budget_exhausted"
        : runs.length
          ? "completed"
          : "empty_control",
      remoteCalls: fixture.calls - callsBefore,
      engineeringJobs: runs.map((r) => ({
        status: r.status,
        attempts: r.attempts,
        failure: r.failureCode,
        usage: r.usage,
        usageIncomplete: r.usageIncomplete,
        model: r.model,
        durationMs: r.durationMs,
      })),
      entityPrecision: active.length
        ? correct / active.length
        : item.goldEntityNames.length
          ? 0
          : 1,
      entityRecall: item.goldEntityNames.length
        ? item.goldEntityNames.filter((n) => names.has(n)).length /
          item.goldEntityNames.length
        : 1,
      evidenceValidity: sources.length
        ? sources.filter(
            (s) =>
              item.chapters.some((t) => t.includes(s.quote)) ||
              item.replacement?.includes(s.quote),
          ).length / sources.length
        : 1,
      entityDedupAccuracy:
        item.id === "repeat-character"
          ? Number(active.filter((e) => e.name === "林舟").length === 1)
          : null,
      revisionUpdateAccuracy: item.replacement
        ? Number(
            !current.some((a) => a.text.includes("十五")) &&
              current.some((a) => a.text.includes("十六")),
          )
        : null,
      relationPrecision: null,
      unsupportedAssertionRate: null,
      staleKnowledgeRate: current.length
        ? current.filter(
            (a) => !a.sources.some((s) => s.validity === "current"),
          ).length / current.length
        : 0,
      elapsedMs: Date.now() - started,
      humanSemanticReview: "pending",
      ...(live ? { entities: page.entities, assertions: page.assertions } : {}),
    };
    if (budgetStopped) {
      for (const metric of [
        "entityPrecision",
        "entityRecall",
        "relationPrecision",
        "evidenceValidity",
        "entityDedupAccuracy",
        "revisionUpdateAccuracy",
        "unsupportedAssertionRate",
        "staleKnowledgeRate",
      ])
        row[metric] = null;
    }
    if (!live && !budgetStopped) {
      assert.ok(runs.every((r) => r.status === "completed"));
      assert.equal(row.evidenceValidity, 1);
      if (row.entityDedupAccuracy !== null)
        assert.equal(row.entityDedupAccuracy, 1);
      if (row.revisionUpdateAccuracy !== null)
        assert.equal(row.revisionUpdateAccuracy, 1);
    }
    results.push(row);
    await checkpoint();
    const final = await call(root);
    await call(root + "/pause", "POST", { baseVersion: final.version });
  }
  const report = {
    modelOrigin: fixture.remoteModelOrigin ?? "isolated HTTP fixture",
    modelCalls: fixture.calls,
    totalInputBytes: fixture.inputBytes,
    limits: {
      modelCalls: fixture.maxCalls,
      priorReservedCalls: Number(
        process.env.WRITER_AGENT_KNOWLEDGE_EVAL_PRIOR_RESERVED_CALLS || 0,
      ),
      totalInputBytes: fixture.maxInputBytes,
      maxOutputTokens: fixture.maxOutputTokens,
    },
    mode: live ? "real-model-synthetic-eval" : "http-mock-engineering",
    cases: results.length,
    metricScope:
      "Entity name/alias matching is automatic gold-name scoring only. Relation precision and unsupported semantic assertions require independent human annotation. Evidence validity counts accepted sources; rejected outputs are job failures, not silently counted as semantic successes.",
    qualityValidated: false,
    budgetExhausted: results.some(
      (r) =>
        r.execution === "budget_exhausted" || r.execution === "not_run_budget",
    ),
    completedCases: results.filter((r) => r.execution === "completed").length,
    casesSentToModel: results.filter((r) => r.remoteCalls > 0).length,
    engineeringFailures: results
      .filter(
        (r) =>
          r.execution !== "budget_exhausted" &&
          r.execution !== "not_run_budget",
      )
      .flatMap((r) => r.engineeringJobs)
      .filter((j) => j.status !== "completed").length,
    totalUsage: results
      .flatMap((r) => r.engineeringJobs)
      .reduce(
        (sum, j) => ({
          inputTokens: sum.inputTokens + (j.usage?.inputTokens ?? 0),
          outputTokens: sum.outputTokens + (j.usage?.outputTokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0 },
      ),
    results,
  };
  if (output)
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  console.log(JSON.stringify(report, null, 2));
  if (live && (report.engineeringFailures || report.budgetExhausted))
    process.exitCode = 1;
} finally {
  await fixture.close();
}
