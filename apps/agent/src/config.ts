import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import {
  thinkingModelSchema,
  type ThinkingModel,
} from "@writer-agent/contracts";
export type Config = {
  state: string;
  port: number;
  storyOrigin: string;
  token: string;
  key: string;
  version: string;
  model: ThinkingModel;
};
export function privateOrigin(raw: string) {
  const u = new URL(raw);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(u.hostname) ||
    !u.port ||
    u.pathname !== "/" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw Error("INVALID_PRIVATE_ORIGIN");
  return u.origin;
}
export function credential(path: string) {
  const st = lstatSync(path);
  if (!st.isFile() || (st.mode & 0o137) !== 0)
    throw Error("UNSAFE_CREDENTIAL_FILE");
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 32) throw Error("INVALID_SERVICE_TOKEN");
  return value;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const n = (key: string, value: number, max: number) => {
    const x = Number(env[`WRITER_AGENT_PI_${key}`] ?? value);
    if (!Number.isSafeInteger(x) || x < 1 || x > max)
      throw Error(`INVALID_${key}`);
    return x;
  };
  const endpoint =
    env.WRITER_AGENT_PI_LLM_BASE_URL ??
    env.WRITER_AGENT_LLM_BASE_URL ??
    "https://api.deepseek.com";
  const u = new URL(endpoint);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        env.WRITER_AGENT_PI_FIXTURE === "1" &&
        u.protocol === "http:" &&
        u.hostname === "127.0.0.1"
      ))
  )
    throw Error("INVALID_MODEL_ENDPOINT");
  const key =
    env.WRITER_AGENT_PI_LLM_API_KEY ?? env.WRITER_AGENT_LLM_API_KEY ?? "";
  if (!key) throw Error("MODEL_KEY_REQUIRED");
  const model = thinkingModelSchema.parse({
    provider: env.WRITER_AGENT_PI_LLM_PROVIDER ?? "deepseek",
    model:
      env.WRITER_AGENT_PI_LLM_MODEL ??
      env.WRITER_AGENT_LLM_MODEL ??
      "deepseek-flash",
    endpoint: u.href.replace(/\/$/, ""),
    protocol: "thinking-v1",
    limits: {
      maxTurnsPerRequest: n("MAX_TURNS", 6, 12),
      maxToolCalls: n("MAX_TOOLS", 12, 32),
      maxInputTokens: n("MAX_INPUT_TOKENS", 32000, 128000),
      maxOutputTokens: n("MAX_OUTPUT_TOKENS", 2048, 8192),
      maxSessionTokens: n("MAX_SESSION_TOKENS", 200000, 2000000),
      maxConcurrentSessions: n("MAX_CONCURRENT", 2, 8),
      maxDurationMs: n("MAX_DURATION_MS", 120000, 300000),
      maxToolResultBytes: n("MAX_RESULT_BYTES", 24000, 64000),
    },
  });
  return {
    state: resolve(env.WRITER_AGENT_PI_STATE_DIR ?? ".writer-agent-pi"),
    port: n("PORT", 8790, 65535),
    storyOrigin: privateOrigin(
      env.WRITER_AGENT_PI_STORY_ORIGIN ?? "http://127.0.0.1:8791",
    ),
    token: credential(env.WRITER_AGENT_PI_SERVICE_TOKEN_FILE ?? ""),
    key,
    model,
    version: releaseVersion(env.WRITER_AGENT_PI_VERSION),
  };
}

function releaseVersion(fallback?: string) {
  try {
    return (
      JSON.parse(
        readFileSync(new URL("../release.json", import.meta.url), "utf8"),
      ) as { revision: string }
    ).revision;
  } catch {
    return fallback ?? "development";
  }
}
