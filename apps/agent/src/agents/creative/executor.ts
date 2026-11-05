import type {AgentTask} from '@writer-agent/contracts';
import {GatewayError,ModelGateway} from '../../runtime/model-gateway.js';
import {orchestratePlanCheck,readonlyPlanStrategy} from './orchestrator.js';

// Creative prompts and schemas are built by Go from the author's captured turn
// or saved revision. The Pi worker never authors them, so drift between two
// bundled prompt copies is impossible; the request hash in the task envelope
// is the execution contract.
export function validateCreative(task:AgentTask,gateway:ModelGateway){
 gateway.validate(task);
 const expected=task.kind==='creative.organize'?'creative_organize':'creative_plan_check';
 if(task.request.schemaName!==expected||!task.request.schema)throw new GatewayError('AGENT_CONFIG_CHANGED');
 if(task.kind==='creative.plan_check'&&!['creative-plan-check-v1',readonlyPlanStrategy].includes(task.strategyVersion))throw new GatewayError('AGENT_CONFIG_CHANGED');
}
export async function executeCreative(task:AgentTask,gateway:ModelGateway,signal:AbortSignal){
 const response=task.kind==='creative.plan_check'&&task.strategyVersion===readonlyPlanStrategy?await orchestratePlanCheck(task,gateway,signal):await gateway.execute(task,signal);
 try{JSON.parse(response.text)}catch{throw new GatewayError('LLM_INVALID_OUTPUT',response)}
 return response;
}
