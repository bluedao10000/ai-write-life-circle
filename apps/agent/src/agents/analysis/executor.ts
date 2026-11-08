import type {AgentTask} from '@writer-agent/contracts';
import {novelAnalysisCandidatesSchema, novelSynthesisCandidatesSchema} from '@writer-agent/contracts';
import {ModelGateway, GatewayError} from '../../runtime/model-gateway.js';
import {outputSchemaVersion, validateAnalysisPrompt} from './prompt.js';

export function validateAnalysis(task: AgentTask, gateway: ModelGateway) {
  gateway.validate(task);
  validateAnalysisPrompt(task);
}

export async function executeAnalysis(task: AgentTask, gateway: ModelGateway, signal: AbortSignal) {
  const response = await gateway.execute(task, signal);
  const schema = task.outputSchemaVersion === outputSchemaVersion ? novelAnalysisCandidatesSchema : novelSynthesisCandidatesSchema;
  try {
    schema.parse(JSON.parse(response.text));
  } catch {
    throw new GatewayError('LLM_INVALID_OUTPUT', response);
  }
  return response;
}
