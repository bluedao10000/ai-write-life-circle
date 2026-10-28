import { createHash } from "node:crypto";

export const defaultLiveSampleCount = 10;

export function selectLiveFixtures(fixtures, full = false) {
  if (full) return fixtures;
  const selected = [];
  for (const scenario of ["character", "worldbuilding", "plot", "craft"]) {
    selected.push(
      ...fixtures.filter(
        (sample) => sample.kind === "default" && sample.scenario === scenario,
      ).slice(0, 2),
    );
  }
  for (const scenario of ["character", "worldbuilding"]) {
    const sample = fixtures.find(
      (fixture) => fixture.kind === "extended" && fixture.scenario === scenario,
    );
    if (sample) selected.push(sample);
  }
  if (selected.length !== defaultLiveSampleCount)
    throw Error("RAS-001 live smoke corpus requires eight default and two extended samples");
  return selected;
}

export function corpusDigest(fixtures) {
  return createHash("sha256")
    .update(fixtures.map((sample) => JSON.stringify(sample)).join("\n"))
    .digest("hex");
}

export function liveUsageTotals(replies, maxOutputTokens) {
  return replies.reduce(
    (totals, reply) => {
      const usage = reply.usage;
      if (!usage) return { ...totals, unknownSamples: totals.unknownSamples + 1 };
      const input = Number.isFinite(usage.input) ? usage.input : 0;
      const output = Number.isFinite(usage.output) ? usage.output : 0;
      const charged = Number.isFinite(usage.charged) ? usage.charged : 0;
      totals.reportedInputTokens += input;
      totals.reportedOutputTokens += output;
      // Unknown provider accounting must never make a live run appear free.
      totals.budgetTokens += usage.incomplete
        ? Math.max(charged, input + output, maxOutputTokens)
        : input + output;
      totals.reservedTokenCeiling += charged;
      if (usage.incomplete) totals.incompleteSamples += 1;
      return totals;
    },
    {
      reportedInputTokens: 0,
      reportedOutputTokens: 0,
      budgetTokens: 0,
      reservedTokenCeiling: 0,
      incompleteSamples: 0,
      unknownSamples: 0,
    },
  );
}

export function assertLiveBudget({ replies, failures = [], maxCalls, maxTotalTokens, maxOutputTokens }) {
  if (replies.length + failures.length >= maxCalls)
    throw liveBudgetError(`RAS-001 live call budget exhausted (${maxCalls})`);
  const totals = liveUsageTotals([...replies, ...failures], maxOutputTokens);
  if (totals.budgetTokens >= maxTotalTokens || totals.unknownSamples)
    throw liveBudgetError(
      `RAS-001 live token budget exhausted or usage unknown (${totals.budgetTokens}/${maxTotalTokens})`,
    );
  return totals;
}

export function liveBudgetError(message) {
  const error = Error(message);
  error.name = "LiveBudgetError";
  return error;
}
