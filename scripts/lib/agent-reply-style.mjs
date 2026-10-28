import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const replyStyleSourcePath = fileURLToPath(
  new URL("../../harness/architecture/agent-reply-style.md", import.meta.url),
);

export async function loadReplyStylePolicy() {
  const markdown = await readFile(replyStyleSourcePath, "utf8");
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw Error("RAS-001 requires a YAML frontmatter block");
  const policy = YAML.parse(match[1]);
  if (policy.policy_id !== "RAS-001") throw Error("Unexpected reply style policy ID");
  if (!policy.policy_version || !policy.runtime_instruction?.trim())
    throw Error("RAS-001 requires policy_version and runtime_instruction");
  if (!Array.isArray(policy.forbidden_phrases) || !policy.forbidden_phrases.length)
    throw Error("RAS-001 requires forbidden_phrases");
  if (!Array.isArray(policy.conclusion_markers) || !policy.conclusion_markers.length)
    throw Error("RAS-001 requires conclusion_markers");
  const limits = policy.default_reply;
  if (
    !limits ||
    !(limits.min_sentences >= 1) ||
    !(limits.max_sentences >= limits.min_sentences) ||
    !(limits.max_visible_characters > 0)
  )
    throw Error("RAS-001 has invalid default_reply limits");
  return policy;
}

export function buildReplyStyleInstruction(policy) {
  const limits = policy.default_reply;
  const questions = policy.max_questions;
  return `Reply style ${policy.policy_id} v${policy.policy_version}: ${policy.runtime_instruction.trim()} For ordinary discussion, normally ${limits.min_sentences}-${limits.max_sentences} sentences and at most ${limits.max_visible_characters} visible characters. Ask at most ${questions} focused question${questions === 1 ? "" : "s"}.\nNever use these canned phrases or close variants: ${policy.forbidden_phrases.join(" / ")}.`;
}

export function visibleText(text) {
  return String(text)
    .replace(/\[\[source:[^\]]+\]\]/g, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]/g, "");
}

export function countVisibleCharacters(text) {
  return Array.from(visibleText(text).replace(/\s/g, "")).length;
}

export function estimateSentenceCount(text) {
  const normalized = visibleText(text).trim();
  if (!normalized) return 0;
  return normalized
    .split(/(?:[。！？!?；;]+|[\r\n]+)/)
    .filter((part) => part.trim().length > 0).length;
}

export function findForbiddenPhrases(text, phrases) {
  const normalized = String(text).toLocaleLowerCase();
  return phrases.filter((phrase) => normalized.includes(phrase.toLocaleLowerCase()));
}

export function hasConclusionFirst(text, markers) {
  const first =
    visibleText(text)
      .split(/(?:[。！？!?；;]+|[\r\n]+)/)
      .find((part) => part.trim().length > 0)
      ?.trim() ?? "";
  return markers.some((marker) => first.includes(marker));
}

export function analyzeReply(sample, policy) {
  const text = String(sample.response ?? "");
  const visibleCharacters = countVisibleCharacters(text);
  const sentenceCount = estimateSentenceCount(text);
  const forbiddenPhrases = findForbiddenPhrases(text, policy.forbidden_phrases);
  const isDefault = sample.kind === "default";
  const lengthPass =
    !isDefault || visibleCharacters <= policy.default_reply.max_visible_characters;
  const sentencePass =
    !isDefault ||
    (sentenceCount >= policy.default_reply.min_sentences &&
      sentenceCount <= policy.default_reply.max_sentences);
  const questionCount = (text.match(/[?？]/g) ?? []).length;
  const questionPass = questionCount <= policy.max_questions;
  const conclusionFirst = hasConclusionFirst(text, policy.conclusion_markers);
  const violations = [];
  if (forbiddenPhrases.length) violations.push("forbidden_phrase");
  if (!lengthPass) violations.push("default_length");
  if (!sentencePass) violations.push("default_sentence_count");
  if (!questionPass) violations.push("question_count");
  if (!conclusionFirst) violations.push("conclusion_first");
  return {
    id: sample.id,
    kind: sample.kind,
    visibleCharacters,
    sentenceCount,
    questionCount,
    forbiddenPhrases,
    lengthPass,
    sentencePass,
    conclusionFirst,
    violations,
  };
}

export function evaluateSamples(samples, policy) {
  const results = samples.map((sample) => analyzeReply(sample, policy));
  const defaults = results.filter((result) => result.kind === "default");
  const average = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const ratio = (values) => average(values.map((value) => (value ? 1 : 0)));
  const targets = policy.metric_targets;
  const metrics = {
    forbiddenPhraseHitRate: ratio(results.map((result) => result.forbiddenPhrases.length > 0)),
    defaultAverageVisibleCharacters: average(
      defaults.map((result) => result.visibleCharacters),
    ),
    extendedAverageVisibleCharacters: average(
      results
        .filter((result) => result.kind === "extended")
        .map((result) => result.visibleCharacters),
    ),
    defaultLengthPassRate: ratio(defaults.map((result) => result.lengthPass)),
    defaultSentencePassRate: ratio(defaults.map((result) => result.sentencePass)),
    conclusionFirstRate: ratio(results.map((result) => result.conclusionFirst)),
    manualPracticalityPassRate:
      samples.length && samples.every((sample) => typeof sample.manualPracticality === "boolean")
        ? ratio(samples.map((sample) => sample.manualPracticality))
        : null,
  };
  const automaticTargetPass = {
    forbiddenPhraseHitRate:
      metrics.forbiddenPhraseHitRate <= targets.forbidden_phrase_hit_rate,
    defaultAverageVisibleCharacters:
      metrics.defaultAverageVisibleCharacters !== null &&
      metrics.defaultAverageVisibleCharacters <=
        targets.default_average_visible_characters,
    defaultLengthPassRate:
      metrics.defaultLengthPassRate >= targets.default_length_pass_rate,
  };
  return {
    metrics,
    automaticTargetPass,
    automaticTargetsPassed: Object.values(automaticTargetPass).every(Boolean),
    results,
    violationExamples: results
      .filter((result) => result.violations.length)
      .slice(0, 20)
      .map((result) => ({
        id: result.id,
        violations: result.violations,
        forbiddenPhrases: result.forbiddenPhrases,
        visibleCharacters: result.visibleCharacters,
        sentenceCount: result.sentenceCount,
      })),
  };
}
