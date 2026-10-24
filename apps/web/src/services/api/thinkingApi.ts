import { z } from "zod";
import {
  thinkingEventsSchema,
  thinkingModelSchema,
  thinkingSessionSchema,
  thinkingSummarySchema,
  type ThinkingCreate,
  type ThinkingMessageInput,
} from "@writer-agent/contracts";
import { requestApi, postJson } from "./client";
const root = (book: string) =>
  `/v1/studio/books/${encodeURIComponent(book)}/thinking`;
export const thinkingApi = {
  async capabilities(book: string, signal?: AbortSignal) {
    return thinkingModelSchema.parse(
      (await requestApi(root(book) + "/capabilities", { signal })).body,
    );
  },
  async list(book: string, signal?: AbortSignal) {
    return thinkingSummarySchema
      .array()
      .parse(
        (
          (await requestApi(root(book) + "/sessions", { signal })).body as {
            items: unknown;
          }
        ).items,
      );
  },
  async create(book: string, input: ThinkingCreate, key: string) {
    return thinkingSessionSchema.parse(
      await postJson(root(book) + "/sessions", input, key),
    );
  },
  async get(book: string, id: string, signal?: AbortSignal) {
    return thinkingSessionSchema.parse(
      (await requestApi(root(book) + "/sessions/" + id, { signal })).body,
    );
  },
  async events(book: string, id: string, after: number, signal?: AbortSignal) {
    return thinkingEventsSchema.parse(
      (
        await requestApi(root(book) + `/sessions/${id}/events?after=${after}`, {
          signal,
        })
      ).body,
    );
  },
  async send(
    book: string,
    id: string,
    input: ThinkingMessageInput,
    key: string,
  ) {
    return z
      .object({ messageId: z.string() })
      .parse(
        await postJson(root(book) + `/sessions/${id}/messages`, input, key),
      );
  },
  async cancel(book: string, id: string) {
    return thinkingSessionSchema.parse(
      await postJson(
        root(book) + `/sessions/${id}/cancel`,
        {},
        crypto.randomUUID(),
      ),
    );
  },
  async delete(book: string, id: string) {
    await requestApi(root(book) + "/sessions/" + id, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  },
};
