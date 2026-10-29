import { z } from "zod";
import {
  thinkingEventsSchema,
  thinkingCancelReceiptSchema,
  thinkingModelsSchema,
  thinkingPreferencesSchema,
  thinkingModelSchema,
  thinkingSessionSchema,
  thinkingHistorySchema,
  thinkingSummarySchema,
  type ThinkingCreate,
  type ThinkingRecovery,
  type ThinkingMessageInput,
} from "@writer-agent/contracts";
import { requestApi, postJson } from "./client";
const root = (book: string) =>
  `/v1/studio/books/${encodeURIComponent(book)}/thinking`;
export const thinkingApi = {
  async models(book: string, signal?: AbortSignal) {
    return thinkingModelsSchema.parse((await requestApi(root(book) + "/models", {signal})).body).items;
  },
  async preferences(book: string, signal?: AbortSignal) {
    return thinkingPreferencesSchema.parse((await requestApi(root(book) + "/preferences", {signal})).body);
  },
  async setPreferences(book: string, scopes: ("chapters" | "knowledge" | "creative" | "notes")[]) {
    return thinkingPreferencesSchema.parse(await postJson(root(book) + "/preferences", {scopes}, crypto.randomUUID()));
  },
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
  async history(book:string,id:string,before?:string,signal?:AbortSignal) {
    const query=before ? `?before=${encodeURIComponent(before)}` : "";
    return thinkingHistorySchema.parse((await requestApi(root(book)+`/sessions/${id}/history${query}`,{signal})).body);
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
  async resume(book: string, id: string, input: ThinkingRecovery, key: string) {
    return z.object({messageId:z.string()}).parse(await postJson(root(book)+`/sessions/${id}/resume`,input,key));
  },
  async cancel(book: string, id: string) {
    const value = await postJson(
      root(book) + `/sessions/${id}/cancel`,
      {},
      crypto.randomUUID(),
    );
    const receipt = thinkingCancelReceiptSchema.safeParse(value);
    return receipt.success ? receipt.data : thinkingSessionSchema.parse(value);
  },
  async delete(book: string, id: string) {
    await requestApi(root(book) + "/sessions/" + id, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  },
};
