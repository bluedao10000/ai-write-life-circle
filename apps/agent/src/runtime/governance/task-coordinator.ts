import {
  thinkingAutonomyCompletionSchema,
  thinkingAutonomyPlanSchema,
  thinkingReadOnlyToolSchema,
  type ThinkingAutonomyCompletion,
  type ThinkingAutonomyRequest,
  type ThinkingAutonomyState,
  type ThinkingReadOnlyTool,
} from "@writer-agent/contracts";
import { z } from "zod";

export const autonomyPlanInputSchema = thinkingAutonomyPlanSchema
  .omit({ steps: true })
  .extend({
    steps: z.array(thinkingAutonomyPlanSchema.shape.steps.element.omit({ status: true })).min(1).max(8),
  })
  .strict();
export const autonomyCompletionInputSchema = thinkingAutonomyCompletionSchema;

const readTools: Record<ThinkingReadOnlyTool, readonly string[]> = {
  retrieve_memory: ["creative", "knowledge"],
  search_knowledge: ["knowledge"],
  read_chapter: ["chapters"],
  get_entity: ["knowledge"],
  find_related_chapters: ["chapters"],
  get_author_notes: ["notes"],
  get_timeline: ["knowledge"],
  get_plot_threads: ["knowledge"],
  list_creative_assets: ["creative"],
  get_creative_asset: ["creative"],
  list_creative_proposals: ["creative"],
  list_open_questions: ["creative"],
  get_writing_context: ["creative"],
  compare_plan_with_manuscript: ["creative"],
  get_discussion_source: ["creative"],
};

export const autonomyTools = thinkingReadOnlyToolSchema.options;

export function allowedAutonomyTools(scopes: readonly string[]): ThinkingReadOnlyTool[] {
  return autonomyTools.filter((tool) => readTools[tool].every((scope) => scopes.includes(scope)));
}

type Bounds = Readonly<{
  maxToolCalls: number;
  maxTurns: number;
  maxDurationMs: number;
}>;

const clone = <T>(value: T): T => structuredClone(value);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/**
 * The plan and completion record live inside the message's existing Durable
 * checkpoint. This class validates transitions; it is not another task or
 * budget authority.
 */
export class AutonomyCoordinator {
  constructor(
    private value: ThinkingAutonomyState,
    private readonly goal: string,
    private readonly scopes: readonly string[],
    bounds: Bounds,
  ) {
    if (
      value.maxSteps > Math.min(8, bounds.maxToolCalls, bounds.maxTurns - 3) ||
      bounds.maxTurns < 4 ||
      bounds.maxToolCalls < 1 ||
      !scopes.length
    )
      throw Error("AUTONOMY_LIMIT_EXCEEDED");
  }

  static initial(
    request: ThinkingAutonomyRequest,
    goal: string,
    scopes: readonly string[],
    bounds: Bounds,
  ) {
    return new AutonomyCoordinator(
      {
        completionCriteria: request.completionCriteria,
        approveReadOnlyTools: true,
        maxSteps: request.maxSteps,
        ...(request.deadlineMs ? { deadlineMs: request.deadlineMs } : {}),
        status: "planning",
      },
      goal,
      scopes,
      bounds,
    );
  }

  static restore(
    state: ThinkingAutonomyState,
    goal: string,
    scopes: readonly string[],
    bounds: Bounds,
  ) {
    return new AutonomyCoordinator(clone(state), goal, scopes, bounds);
  }

  projection(): ThinkingAutonomyState {
    return clone(this.value);
  }

  resume(recoveredStepIds: ReadonlySet<string> = new Set()) {
    if (!this.value.plan || this.value.status === "cancelled") return;
    if (this.value.completion) {
      this.value.status = this.value.completion.status === "complete" ? "completed" : "needs_input";
      delete this.value.errorCode;
      return;
    }
    for (const step of this.value.plan.steps) {
      if (
        step.status === "running" ||
        step.status === "failed" ||
        (step.status === "completed" && !recoveredStepIds.has(step.stepId))
      )
        step.status = "pending";
    }
    this.value.status = "planned";
    delete this.value.errorCode;
  }

  adopt(input: z.infer<typeof autonomyPlanInputSchema>) {
    if (this.value.plan || this.value.status !== "planning") throw Error("AUTONOMY_PLAN_REJECTED");
    if (
      input.goal !== this.goal ||
      input.completionCriteria !== this.value.completionCriteria ||
      input.steps.length < 1 ||
      input.steps.length > this.value.maxSteps ||
      !unique(input.steps.map((step) => step.stepId))
    )
      throw Error("AUTONOMY_PLAN_REJECTED");
    const allowed = new Set(allowedAutonomyTools(this.scopes));
    if (input.steps.some((step) => !allowed.has(step.tool))) throw Error("AUTONOMY_PLAN_REJECTED");
    this.value.plan = {
      goal: this.goal,
      completionCriteria: this.value.completionCriteria,
      steps: input.steps.map((step) => ({ ...step, status: "pending" as const })),
    };
    this.value.status = "planned";
    return this.projection();
  }

  beginStep(stepId: string, tool: ThinkingReadOnlyTool) {
    const step = this.value.plan?.steps.find((candidate) => candidate.stepId === stepId);
    if (
      this.value.completion ||
      !["planned", "running"].includes(this.value.status) ||
      !step ||
      step.tool !== tool ||
      step.status !== "pending"
    )
      throw Error("AUTONOMY_PLAN_REJECTED");
    step.status = "running";
    this.value.status = "running";
    return this.projection();
  }

  completeStep(stepId: string) {
    const step = this.value.plan?.steps.find((candidate) => candidate.stepId === stepId);
    if (!step || step.status !== "running") throw Error("AUTONOMY_PLAN_REJECTED");
    step.status = "completed";
    this.value.status = this.value.plan!.steps.every((candidate) => candidate.status === "completed")
      ? "planned"
      : "running";
    return this.projection();
  }

  failStep(stepId: string) {
    const step = this.value.plan?.steps.find((candidate) => candidate.stepId === stepId);
    if (step?.status === "running") step.status = "failed";
  }

  complete(input: ThinkingAutonomyCompletion) {
    if (this.value.completion || !this.value.plan) throw Error("AUTONOMY_PLAN_REJECTED");
    const completed = this.value.plan.steps
      .filter((step) => step.status === "completed")
      .map((step) => step.stepId);
    if (
      !unique(input.completedStepIds) ||
      input.completedStepIds.length !== completed.length ||
      !completed.every((stepId) => input.completedStepIds.includes(stepId))
    )
      throw Error("AUTONOMY_PLAN_REJECTED");
    const pending = this.value.plan.steps.filter((step) => step.status !== "completed");
    if (input.status === "complete") {
      if (pending.length || input.completedStepIds.length !== this.value.plan.steps.length)
        throw Error("AUTONOMY_PLAN_REJECTED");
      if (input.remainingSteps.length) throw Error("AUTONOMY_PLAN_REJECTED");
    } else {
      if (!pending.length) throw Error("AUTONOMY_PLAN_REJECTED");
      const remaining = input.remainingSteps.map((step) => step.stepId);
      if (
        remaining.length !== pending.length ||
        !unique(remaining) ||
        !pending.every((step) => remaining.includes(step.stepId))
      )
        throw Error("AUTONOMY_PLAN_REJECTED");
    }
    this.value.completion = clone(input);
    this.value.status = input.status === "complete" ? "completed" : "needs_input";
    return this.projection();
  }

  requireCompletion() {
    if (!this.value.completion || !["completed", "needs_input"].includes(this.value.status))
      throw Error("AUTONOMY_INCOMPLETE");
  }

  markFailure(errorCode: string) {
    if (this.value.status === "cancelled") return;
    this.value.status = "failed";
    this.value.errorCode = errorCode;
  }

  markCancelled() {
    this.value.status = "cancelled";
    this.value.errorCode = "CANCELLED";
  }
}
