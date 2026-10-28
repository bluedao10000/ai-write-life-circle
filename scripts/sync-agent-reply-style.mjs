import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildReplyStyleInstruction,
  loadReplyStylePolicy,
} from "./lib/agent-reply-style.mjs";

const generatedPath = fileURLToPath(
  new URL(
    "../apps/agent/src/agents/thinking/reply-style.generated.ts",
    import.meta.url,
  ),
);
const policy = await loadReplyStylePolicy();
const instruction = buildReplyStyleInstruction(policy);
const literal = (value) => JSON.stringify(value, null, 2);
const generated = `// Generated from harness/architecture/agent-reply-style.md by scripts/sync-agent-reply-style.mjs.\n// Do not edit manually; run pnpm style:sync.\nexport const replyStylePolicy = ${literal({
  id: policy.policy_id,
  version: policy.policy_version,
  defaultReply: {
    minSentences: policy.default_reply.min_sentences,
    maxSentences: policy.default_reply.max_sentences,
    maxVisibleCharacters: policy.default_reply.max_visible_characters,
  },
  maxQuestions: policy.max_questions,
  forbiddenPhrases: policy.forbidden_phrases,
})} as const;\n\nexport const replyStyleInstruction = ${JSON.stringify(instruction)};\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(generatedPath, "utf8").catch(() => "");
  if (existing !== generated) {
    process.stderr.write(
      "RAS-001 generated prompt is stale. Run `pnpm style:sync`.\n",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(generatedPath, generated, "utf8");
  console.log("Generated apps/agent/src/agents/thinking/reply-style.generated.ts");
}
