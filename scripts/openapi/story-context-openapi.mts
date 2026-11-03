import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  storyContextSchema, storyChangeListSchema, storyChangeReceiptSchema,
  creativeSettingsSchema, dialogueRecordingInputSchema,
  discussionFocusSchema, authorDiscussionFocusInputSchema,
} from "../../packages/contracts/src/creative.js";

const types = {
  storyContext: storyContextSchema,
  storyChangeList: storyChangeListSchema,
  storyChangeReceipt: storyChangeReceiptSchema,
  creativeSettings: creativeSettingsSchema,
  dialogueRecordingInput: dialogueRecordingInputSchema,
  discussionFocus: discussionFocusSchema,
  authorDiscussionFocusInput: authorDiscussionFocusInputSchema,
  emptyInput: z.object({}).strict(),
};
const schemas = Object.fromEntries(Object.entries(types).map(([key, value]) => [
  key, z.toJSONSchema(value, { target: "draft-2020-12", io: "input" }),
]));
const param = (name: string, location = "path", required = true) => ({
  name, in: location, required, schema: { type: "string" },
});
const json = (name: string) => ({"application/json": {schema: {$ref: "#/components/schemas/" + name}}});
const op = (id: string, output: string, input?: string) => ({
  operationId: id, summary: id, tags: ["Story context"], security: [{authorBearer: []}],
  ...(input ? {
    parameters: [param("Idempotency-Key", "header")],
    requestBody: {required: true, content: json(input)},
  } : {}),
  responses: {
    200: {description: "Current author-owned story state", content: json(output)},
    401: {description: "Author session required"},
    404: {description: "Unknown or unowned book, discussion or change"},
    409: {description: "A later edit prevents undo, or idempotency key was reused"},
    422: {description: "Invalid request"},
  },
});
const base = "/studio/books/{bookId}/creative";
const doc = {
  openapi: "3.1.0",
  info: {
    title: "Writer Agent Story Context v1", version: "1.0.0",
    description: "Book-wide author settings, per-discussion focus and durable, undoable dialogue changes. Recording is independent of background organization. Agent write tools remain private capability-bound endpoints.",
  },
  servers: [{url: "/v1"}],
  paths: {
    [base + "/story-context"]: {
      parameters: [param("bookId"), param("sessionId", "query", false), param("q", "query", false)],
      get: op("getStoryContext", "storyContext"),
    },
    [base + "/changes"]: {
      parameters: [param("bookId"), param("sessionId", "query", false)],
      get: op("listStoryChanges", "storyChangeList"),
    },
    [base + "/changes/{changeId}/undo"]: {
      parameters: [param("bookId"), param("changeId")],
      post: op("undoStoryChange", "storyChangeReceipt", "emptyInput"),
    },
    [base + "/changes/{changeId}/apply"]: {
      parameters: [param("bookId"), param("changeId")],
      post: op("applyStoryChange", "storyChangeReceipt", "emptyInput"),
    },
    [base + "/discussion-focus"]: {
      parameters: [param("bookId")],
      post: op("editDiscussionFocus", "discussionFocus", "authorDiscussionFocusInput"),
    },
    [base + "/settings/recording"]: {
      parameters: [param("bookId")],
      post: op("setDialogueRecording", "creativeSettings", "dialogueRecordingInput"),
    },
  },
  components: {
    securitySchemes: {authorBearer: {type: "http", scheme: "bearer"}},
    schemas,
  },
};
const path = new URL("../../harness/contracts/story-context-api-v1.json", import.meta.url);
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== text) throw Error("Story context OpenAPI is stale");
} else await writeFile(path, text);
