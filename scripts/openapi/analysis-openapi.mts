import { readFile, writeFile } from "node:fs/promises";
import { analysisJsonSchemas as schemas } from "../../packages/contracts/src/analysis.js";
const param = { name: "bookId", in: "path", required: true, schema: { type: "string" } };
const idempotency = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", maxLength: 128 },
};
function operation(id: string, post = false, input?: string) {
  return {
    operationId: id,
    summary: id,
    security: [{ authorBearer: [] }],
    tags: ["Private novel analysis"],
    parameters: post ? [param, idempotency] : [param],
    ...(post
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: input
                  ? { $ref: `#/components/schemas/${input}` }
                  : { type: "object", additionalProperties: false },
              },
            },
          },
        }
      : {}),
    responses: {
      200: {
        description: "Private no-store analysis view",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/NovelAnalysisView" } },
        },
      },
      ...Object.fromEntries(
        [401, 403, 404, 405, 409, 413, 422, 429, 500, 503].map((code) => [
          code,
          { description: "Author, ownership, revision, budget, validation or storage failure" },
        ]),
      ),
    },
  };
}
const root = "/studio/books/{bookId}/analysis";
const paths: Record<string, unknown> = {
  [root]: { get: operation("getNovelAnalysis"), post: operation("createNovelAnalysis", true, "CreateAnalysisInput") },
};
for (const action of ["pause", "resume", "cancel"]) paths[`${root}/${action}`] = { post: operation("novelAnalysis" + action, true) };
paths[`${root}/findings/{findingId}/decision`] = {
  post: {
    ...operation("decideNovelAnalysisFinding", true, "AnalysisDecisionInput"),
    parameters: [
      param,
      { name: "findingId", in: "path", required: true, schema: { type: "string", pattern: "^find-[0-9a-f]{24}$" } },
      idempotency,
    ],
  },
};
const doc = {
  openapi: "3.1.0",
  info: {
    title: "Writer Agent Novel Intelligence",
    version: "1.0.0",
    description:
      "Whole-book analysis jobs: revision-bound manifests, chapter batches, evidence-validated candidates and author-only decisions. Candidates never become canon automatically.",
    license: { name: "Private", url: "https://github.com/story2u/ai-write-life-circle" },
  },
  servers: [{ url: "http://127.0.0.1:8787/v1" }],
  tags: [{ name: "Private novel analysis", description: "Author-reviewable whole-book candidates" }],
  paths,
  components: { securitySchemes: { authorBearer: { type: "http", scheme: "bearer" } }, schemas },
};
const output = JSON.stringify(doc, null, 2) + "\n",
  path = new URL("../../harness/contracts/analysis-api-v1.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output) throw new Error("Novel analysis OpenAPI stale");
} else await writeFile(path, output);
