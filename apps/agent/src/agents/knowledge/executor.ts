import type {AgentTask} from '@writer-agent/contracts';
import {ModelGateway,GatewayError} from '../../runtime/model-gateway.js';
import {validateKnowledgePrompt} from './prompt.js';
import {knowledgeCandidates} from './schema.js';
export function validateKnowledge(task:AgentTask,gateway:ModelGateway){gateway.validate(task);validateKnowledgePrompt(task)}
export async function executeKnowledge(task:AgentTask,gateway:ModelGateway,signal:AbortSignal){
 const response=await gateway.execute(task,signal);
 try{knowledgeCandidates.parse(JSON.parse(response.text))}catch{throw new GatewayError('LLM_INVALID_OUTPUT',response)}
 return response;
}
