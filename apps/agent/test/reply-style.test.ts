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
  assert(replyStyleInstruction.includes("explicitly requests deep, complete or detailed analysis"));
  assert(replyStyleInstruction.includes("without the ordinary length limit"));
  assert(replyStyleInstruction.includes("Never trade accuracy, source fidelity"));
});
