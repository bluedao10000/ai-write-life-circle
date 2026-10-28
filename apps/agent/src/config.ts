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
  models?: { model: ThinkingModel; key: string; enabled: boolean; description: string }[];
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
  if (!key && !env.WRITER_AGENT_PI_MODELS_FILE) throw Error("MODEL_KEY_REQUIRED");
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
  const models = loadModels(env, model, key);
  return {
    models,
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

// Only operator-owned configuration can select URLs and credential references.
function loadModels(env: NodeJS.ProcessEnv, fallback: ThinkingModel, key: string): NonNullable<Config["models"]> {
  if (!env.WRITER_AGENT_PI_MODELS_FILE) return [{model: fallback, key, enabled: true, description: "创作讨论与作品资料分析"}];
  const file = env.WRITER_AGENT_PI_MODELS_FILE;
  const st = lstatSync(file);
  if (!st.isFile() || (st.mode & 0o022) !== 0 || st.size > 65536) throw Error("UNSAFE_MODELS_FILE");
  const rows: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(rows) || !rows.length || rows.length > 16) throw Error("INVALID_MODELS");
  const seen = new Set<string>();
  return rows.map((row: {model: unknown; keyEnv: string; enabled?: boolean; description?: string}) => {
    const m = thinkingModelSchema.parse(row.model);
    if (!m.modelId || seen.has(m.modelId)) throw Error("INVALID_MODEL_ID");
    seen.add(m.modelId);
    const u = new URL(m.endpoint);
    if (u.username || u.password || u.search || u.hash || (u.protocol !== "https:" && !(env.WRITER_AGENT_PI_FIXTURE === "1" && u.origin.startsWith("http://127.0.0.1:")))) throw Error("INVALID_MODEL_ENDPOINT");
    const l = m.limits;
    if (l.maxTurnsPerRequest < 2 || l.maxTurnsPerRequest > 8 || l.maxToolCalls > 12 || l.maxInputTokens > 128000 || l.maxOutputTokens > 16384 || l.maxSessionTokens > 2000000 || l.maxDurationMs > 300000 || l.maxToolResultBytes > 64000 || l.maxConcurrentSessions > 8) throw Error("INVALID_MODEL_LIMITS");
    if (!/^[A-Z][A-Z0-9_]+$/.test(row.keyEnv)) throw Error("INVALID_MODEL_KEY_REF");
    const credential = env[row.keyEnv] ?? "";
    if (row.enabled !== false && !credential) throw Error("MODEL_KEY_REQUIRED");
    return {model: m, key: credential, enabled: row.enabled !== false, description: (row.description ?? "创作讨论与作品资料分析").slice(0, 160)};
  });
}
export function modelEntries(config: Config) {
  return config.models ?? [{model: config.model, key: config.key, enabled: true, description: "创作讨论与作品资料分析"}];
}
export const modelId = (model: ThinkingModel) => model.modelId ?? "default";
