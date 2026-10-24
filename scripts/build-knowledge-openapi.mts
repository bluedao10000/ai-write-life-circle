import { readFile, writeFile } from "node:fs/promises";
import { knowledgeJsonSchemas as schemas } from "../packages/contracts/src/knowledge.js";
const param = {
  name: "bookId",
  in: "path",
  required: true,
  schema: { type: "string" },
};
function operation(
  id: string,
  output: string,
  post = false,
  extra: unknown[] = [],
) {
  return {
    operationId: id,
    summary: id,
    security: [{ authorBearer: [] }],
    tags: ["Private AI knowledge"],
    parameters: [
      param,
      ...extra,
      ...(post
        ? [
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string", maxLength: 128 },
            },
          ]
        : [
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 30,
              },
            },
            {
              name: "cursor",
              in: "query",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
          ]),
    ],
    ...(post
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MemoryMutation" },
              },
            },
          },
        }
      : {}),
    responses: {
      200: {
        description: "Private no-store knowledge response",
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${output}` },
          },
        },
      },
      ...Object.fromEntries(
        [401, 403, 404, 405, 409, 413, 422, 429, 500, 503].map((code) => [
          code,
          {
            description:
              "Author, ownership, CAS, validation, budget or storage failure",
          },
        ]),
      ),
    },
  };
}
const root = "/studio/books/{bookId}/knowledge";
const paths: Record<string, unknown> = {
  [root + "/summary"]: {
    get: operation("summaryMemory", "MemoryView", false),
  },
  [root]: {
    get: operation(
      "queryMemory",
      "MemoryPage",
      false,
      ["type", "name", "chapterId", "status"].map((name) => ({
        name,
        in: "query",
        schema: { type: "string" },
      })),
    ),
  },
  [root + "/related"]: {
    get: operation("relatedMemory", "MemoryPage", false, [
      {
        name: "chapterId",
        in: "query",
        required: true,
        schema: { type: "string" },
      },
    ]),
  },
  [root + "/entities/{entityId}"]: {
    get: operation("getMemoryEntity", "MemoryPage", false, [
      {
        name: "entityId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ]),
  },
};
for (const [kind, schema] of [
  ["jobs", "MemoryJobs"],
  ["history", "MemoryHistory"],
  ["corrections", "MemoryCorrections"],
])
  paths[root + "/" + kind] = { get: operation("listMemory" + kind, schema) };
for (const action of [
  "enable",
  "pause",
  "resume",
  "rebuild",
  "correct",
  "undo",
])
  paths[root + "/" + action] = {
    post: operation("memory" + action, "MemoryView", true),
  };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "Writer Agent Private AI Knowledge",
    version: "1.0.0",
    description:
      "One-time per-book model consent, private derived observations, durable bounded extraction; no public DTO or author canon writes.",
    license: {
      name: "Private",
      url: "https://github.com/story2u/ai-write-life-circle",
    },
  },
  servers: [{ url: "http://127.0.0.1:8787/v1" }],
  tags: [
    {
      name: "Private AI knowledge",
      description: "Automatic private memory, not manual knowledge CRUD",
    },
  ],
  paths,
  components: {
    securitySchemes: { authorBearer: { type: "http", scheme: "bearer" } },
    schemas,
  },
};
const output = JSON.stringify(doc, null, 2) + "\n",
  path = new URL("../harness/contracts/knowledge-api-v1.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output)
    throw new Error("Knowledge OpenAPI stale");
} else await writeFile(path, output);
