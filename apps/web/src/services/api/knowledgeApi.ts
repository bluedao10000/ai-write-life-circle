import {
  memoryPageSchema,
  memoryViewSchema,
  memoryJobsSchema,
  memoryHistorySchema,
  memoryCorrectionsSchema,
  memoryMutationSchema,
  type MemoryMutation,
} from "@writer-agent/contracts";
import { requestApi, postJson } from "./client";
const root = (id: string) =>
  `/v1/studio/books/${encodeURIComponent(id)}/knowledge`;

function parseMemory<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    // A strict contract mismatch must never dump raw JSON validation details into
    // the manuscript UI. Keep diagnostics in developer tooling and give the
    // author a stable retryable message.
    throw new Error("作品记忆响应格式已更新，请刷新页面后重试。");
  }
}

export const knowledgeApi = {
  async summary(id: string, signal?: AbortSignal) {
    return parseMemory(
      memoryViewSchema,
      (await requestApi(`${root(id)}/summary`, { signal })).body,
    );
  },
  async query(
    id: string,
    query: URLSearchParams,
    signal?: AbortSignal,
    suffix = "",
  ) {
    return parseMemory(
      memoryPageSchema,
      (await requestApi(`${root(id)}${suffix}?${query}`, { signal })).body,
    );
  },
  async mutate(
    id: string,
    action: string,
    input: MemoryMutation,
    key = crypto.randomUUID(),
  ) {
    return parseMemory(
      memoryViewSchema,
      await postJson(
        `${root(id)}/${action}`,
        memoryMutationSchema.parse(input),
        key,
      ),
    );
  },
  async jobs(id: string, signal?: AbortSignal) {
    return parseMemory(
      memoryJobsSchema,
      (await requestApi(`${root(id)}/jobs`, { signal })).body,
    );
  },
  async history(id: string, signal?: AbortSignal, cursor = 0) {
    return parseMemory(
      memoryHistorySchema,
      (await requestApi(`${root(id)}/history?cursor=${cursor}`, { signal }))
        .body,
    );
  },
  async corrections(id: string, signal?: AbortSignal) {
    return parseMemory(
      memoryCorrectionsSchema,
      (await requestApi(`${root(id)}/corrections`, { signal })).body,
    );
  },
};
