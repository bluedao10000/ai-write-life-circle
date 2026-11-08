import type {AgentTask} from '@writer-agent/contracts';
import {createHash} from 'node:crypto';

export const strategy = 'novel-intelligence-v1';
export const outputSchemaVersion = 'novel-analysis-candidates-v1';
export const synthesisOutputSchemaVersion = 'novel-synthesis-candidates-v1';
// Matches analysis.ExecutionContract in Go: strategy + both output schema names.
export const executionContract = 'sha256:' + createHash('sha256').update(strategy + outputSchemaVersion + synthesisOutputSchemaVersion).digest('hex');

export function validateAnalysisPrompt(task: AgentTask) {
  if (
    task.kind !== 'novel.analyze' ||
    task.strategyVersion !== strategy ||
    (task.outputSchemaVersion !== outputSchemaVersion && task.outputSchemaVersion !== synthesisOutputSchemaVersion)
  )
    throw Error('AGENT_CONFIG_CHANGED');
}
