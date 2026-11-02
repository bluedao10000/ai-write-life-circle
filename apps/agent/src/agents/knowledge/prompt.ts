import type {AgentTask} from '@writer-agent/contracts';

export const strategy = 'knowledge-extraction-v1';
export const outputSchemaVersion = 'knowledge-candidates-v1';

export function validateKnowledgePrompt(task: AgentTask) {
  if (task.kind !== 'knowledge.extract' || task.strategyVersion !== strategy || task.outputSchemaVersion !== outputSchemaVersion)
    throw Error('AGENT_CONFIG_CHANGED');
}
