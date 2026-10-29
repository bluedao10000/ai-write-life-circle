import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import * as c from "../packages/contracts/src/thinking.js";
const schemas = Object.fromEntries(
  Object.entries(c)
    .filter(([key]) => key.endsWith("Schema"))
    .map(([key, value]) => [
      key.replace("Schema", ""),
      z.toJSONSchema(value as z.ZodType, { target: "draft-2020-12" }),
    ]),
);
const param = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});
const op = (id: string, output: string, input?: string, status = 200) => ({
  operationId: id,
  summary: id,
  security: [{ authorBearer: [] }],
  tags: ["Private thinking"],
  ...(input
    ? {
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: !id.includes("cancel"),
            schema: { type: "string", maxLength: 128 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/" + input },
            },
          },
        },
      }
    : {}),
  responses: {
    [status]: {
      description: "Author-scoped response; no model credential",
      ...(status !== 204
        ? {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/" + output },
              },
            },
          }
        : {}),
    },
    401: { description: "Author session required" },
    403: { description: "Grant revoked or wrong scope" },
    404: { description: "Unknown or unowned resource" },
    409: { description: "Busy or model consent changed" },
    422: { description: "Invalid input, selection or budget" },
    429: { description: "Budget or capacity exhausted" },
    503: { description: "Thinking unavailable; writing remains independent" },
  },
});
const base = "/studio/books/{bookId}/thinking";
const paths = {
  [base + "/models"]: {parameters: [param("bookId")], get: op("listThinkingModels", "thinkingModels")},
  [base + "/preferences"]: {parameters: [param("bookId")], get: op("getThinkingPreferences", "thinkingPreferences"), post: {...op("setThinkingPreferences", "thinkingPreferences", "thinkingPreferences"), parameters: []}},
  [base + "/capabilities"]: {
    parameters: [param("bookId")],
    get: op("getThinkingCapabilities", "thinkingModel"),
  },
  [base + "/sessions"]: {
    parameters: [param("bookId")],
    get: {
      ...op("listThinkingSessions", "thinkingSummary"),
      responses: {
        200: {
          description: "Go-owned session metadata",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/thinkingSummary" },
                  },
                },
                required: ["items"],
              },
            },
          },
        },
      },
    },
    post: op("createThinkingSession", "thinkingSession", "thinkingCreate", 201),
  },
  [base + "/sessions/{sessionId}"]: {
    parameters: [param("bookId"), param("sessionId")],
    get: op("getThinkingSession", "thinkingSession"),
    delete: op("deleteThinkingSession", "thinkingSession", undefined, 204),
  },
  [base + "/sessions/{sessionId}/messages"]: {
    parameters: [param("bookId"), param("sessionId")],
    post: op(
      "acceptThinkingMessage",
      "thinkingReceipt",
      "thinkingMessageInput",
      202,
    ),
  },
  [base + "/sessions/{sessionId}/resume"]: {
    parameters: [param("bookId"),param("sessionId")],
    post: op("resumeThinkingRun", "thinkingReceipt", "thinkingRecovery",202),
  },
  [base + "/sessions/{sessionId}/events"]: {
    parameters: [
      param("bookId"),
      param("sessionId"),
      { name: "after", in: "query", schema: { type: "integer", minimum: 0 } },
    ],
    get: op("pollThinkingEvents", "thinkingEvents"),
  },
  [base + "/sessions/{sessionId}/cancel"]: {
    parameters: [param("bookId"), param("sessionId")],
    post: op("cancelThinkingRequest", "thinkingSession"),
  },
};
const doc = {
  openapi: "3.1.0",
  info: {
    title: "Writer Agent Thinking v1",
    version: "1.0.0",
    description:
      "Public author API uses cursor polling across Cloudflare. Private sidecar SSE and Go capability tools bind separate loopback listeners; never proxy /internal. Thinking consent is independent of Knowledge.",
  },
  servers: [{ url: "/v1" }],
  paths,
  components: {
    securitySchemes: {
      authorBearer: {
        type: "http",
        scheme: "bearer",
        description: "Go bearer behind authenticated Better Auth Worker",
      },
    },
    schemas: {
      ...schemas,
      thinkingReceipt: {
        type: "object",
        required: ["messageId"],
        properties: { messageId: { type: "string" } },
      },
    },
  },
};
const path = new URL(
    "../harness/contracts/thinking-api-v1.json",
    import.meta.url,
  ),
  text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== text)
    throw Error("Thinking OpenAPI is stale");
} else await writeFile(path, text);
