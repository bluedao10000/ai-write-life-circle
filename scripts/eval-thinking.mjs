import { writeFile, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  startThinkingFixture,
  seedThinkingBook,
} from "./lib/thinking-fixture.mjs";
const live = process.argv.includes("--live");
if (live && !process.argv.includes("--confirm-fixtures"))
  throw Error(
    "Live evaluation requires --confirm-fixtures; no author manuscripts are used",
  );
const f = await startThinkingFixture({ live });
try {
  const book = await seedThinkingBook(f),
    base = `/v1/studio/books/${book.bookId}/thinking`,
    model = await f.call(base + "/capabilities"),
    session = await f.call(base + "/sessions", {
      method: "POST",
      status: 201,
      key: "eval",
      body: { consent: true, model, scopes: ["chapters", "knowledge"] },
    }),
    path = base + "/sessions/" + session.sessionId;
  const start = Date.now();
  await f.call(path + "/messages", {
    method: "POST",
    key: "eval-q1",
    status: 202,
    body: {
      text: "林舟与父亲的关系变化是否合理？请区分原文与推断，并引用各章。",
    },
  });
  let result;
  for (let i = 0; i < 3200; i++) {
    result = await f.call(path);
    if (result.status === "idle") break;
    await delay(50);
  }
  if (result.status !== "idle") throw Error("Evaluation exceeded deadline");
  const answer = result.messages.at(-1),
    events = await f.call(path + "/events?after=0"),
    sources = answer.sources,
    expected = new Set(book.chapters.map((c) => c.chapterId)),
    found = new Set(sources.map((s) => s.chapterId)),
    markers = [...answer.text.matchAll(/\[\[source:([^\]]+)\]\]/g)].map(
      (m) => m[1],
    ),
    validIds = new Set(sources.map((s) => s.sourceId));
  const report = {
    schema: 1,
    synthetic: true,
    mode: live ? "live-model" : "mock-http-model",
    realLLMCalled: live,
    qualityValidated: false,
    model,
    at: new Date().toISOString(),
    metrics: {
      evidencePrecision: null,
      citationValidity: markers.length
        ? markers.filter((id) => validIds.has(id)).length / markers.length
        : null,
      relevantChapterRecall:
        [...expected].filter((id) => found.has(id)).length / expected.size,
      unsupportedClaimRate: null,
      toolCalls: events.items.filter((e) => e.type === "tool_started").length,
      toolCallEfficiency: {
        retrievedRelevantChapters: found.size,
        totalToolCalls: events.items.filter((e) => e.type === "tool_started")
          .length,
      },
      costPerRequest: {
        currency: null,
        chargedTokenCeiling: result.usage.charged,
        reportedInput: result.usage.input,
        reportedOutput: result.usage.output,
        incomplete: result.usage.incomplete,
      },
      completionRate: answer.status === "completed" ? 1 : 0,
      durationMs: Date.now() - start,
    },
    answer,
    toolEvents: events.items.filter((e) => e.type.startsWith("tool_")),
    humanReviewRequired: [
      "Evidence Precision",
      "Unsupported Claim Rate",
      "Literary intent and alternative explanations",
    ],
  };
  await mkdir(".local/evals/thinking-agent", { recursive: true });
  const pathReport = `.local/evals/thinking-agent/${live ? "live" : "mock"}-report.json`;
  await writeFile(pathReport, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: pathReport,
      realLLMCalled: live,
      qualityValidated: false,
      metrics: report.metrics,
    }),
  );
  if (answer.status !== "completed")
    throw Error("Engineering completion failed; inspect synthetic report");
} finally {
  await f.close();
}
