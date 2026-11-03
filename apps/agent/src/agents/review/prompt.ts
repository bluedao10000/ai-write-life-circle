import type {AgentTask} from '@writer-agent/contracts';

export const strategy = 'continuity-review-v4';
export const outputSchemaVersion = 'review-candidates-v1';

export function validateReviewPrompt(task: AgentTask) {
  if (task.kind !== 'review.execute' || task.strategyVersion !== strategy || task.outputSchemaVersion !== outputSchemaVersion)
    throw Error('AGENT_CONFIG_CHANGED');
}
