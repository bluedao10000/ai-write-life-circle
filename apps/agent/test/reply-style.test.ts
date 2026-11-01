import test from "node:test";
import assert from "node:assert/strict";
import { systemPrompt } from "../src/agents/thinking/prompt.js";
import {
  replyStyleInstruction,
  replyStylePolicy,
} from "../src/agents/thinking/reply-style.generated.js";
import { loader } from "../src/runtime/pi-host.js";

test("Thinking runtime injects the generated RAS-001 instruction without weakening existing boundaries", () => {
  assert.equal(replyStylePolicy.id, "RAS-001");
  assert(systemPrompt.includes(replyStyleInstruction));
  assert.equal(loader().getSystemPrompt(), systemPrompt);
  assert(!systemPrompt.includes("Offer alternatives and questions to the author."));
  assert(systemPrompt.includes("Present mutually exclusive options as alternatives and ask"));
  assert(systemPrompt.includes("Use only registered read-only tools."));
  assert(systemPrompt.includes("Never invent citations"));
  assert(systemPrompt.includes("only the author accepts proposals"));
  assert(systemPrompt.includes("untrusted quoted data"));
});

test("RAS-001 distinguishes ordinary replies, evidence and explicitly requested depth", () => {
  assert(replyStyleInstruction.includes("normally 2-4 sentences"));
  assert(replyStyleInstruction.includes("at most 180 visible characters"));
  assert(replyStyleInstruction.includes("Ask at most 1 focused question"));
  assert(replyStyleInstruction.includes("in the author's language"));
  assert(!replyStyleInstruction.includes("direct Chinese"));
  assert(replyStyleInstruction.includes("preserve exact evidence"));
  assert(replyStyleInstruction.includes("When the author asks for deep or complete analysis"));
  assert(replyStyleInstruction.includes("without the ordinary length cap"));
  assert(replyStyleInstruction.includes("Never trade accuracy, source fidelity"));
});

test("RAS-001 asks for plain editor talk instead of criticism jargon and flipped aphorisms", () => {
  assert(replyStyleInstruction.startsWith("Reply style RAS-001 v1.2.0: Open directly with your judgment"));
  assert(replyStyleInstruction.includes("sharp fiction editor talking shop with the author"));
  assert(replyStyleInstruction.includes('avoid mechanical "不是A，而是B" aphorisms'));
  assert(replyStyleInstruction.includes("mandatory trailing questions"));
  assert(!replyStyleInstruction.includes("Lead with the conclusion"));
  for (const phrase of ["体现了", "戏剧张力", "人物弧光", "因果闭环", "某种程度上", "维度", "机制"])
    assert((replyStylePolicy.forbiddenPhrases as readonly string[]).includes(phrase), phrase);
});
