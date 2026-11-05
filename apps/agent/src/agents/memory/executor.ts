import {z} from 'zod';
import type {AgentTask} from '@writer-agent/contracts';
import {GatewayError,ModelGateway} from '../../runtime/model-gateway.js';

export const memoryConsolidationStrategy='memory-consolidation-v1';
const outputSchema=z.object({
  content:z.string().nullable(),
  taskIds:z.array(z.string()).max(4),
  relations:z.array(z.object({
    memoryId:z.string().min(1),
    kind:z.enum(['duplicate','conflict','refinement']),
    reason:z.string().trim().min(1).max(1000),
  }).strict()).max(8),
}).strict().superRefine((value,ctx)=>{
  const content=value.content?.trim()??null;
  const unique=new Set(value.taskIds);
  if(unique.size!==value.taskIds.length||((content===null||content==='')&&(value.taskIds.length!==0||value.relations.length!==0))||(content!==null&&content!==''&&value.taskIds.length<2)){
    ctx.addIssue({code:'custom',message:'Invalid memory consolidation output'});
  }
  if(content&&Buffer.byteLength(content)>4000)ctx.addIssue({code:'custom',message:'Memory candidate too large'});
  const targets=new Set(value.relations.map(item=>item.memoryId));
  if(targets.size!==value.relations.length)ctx.addIssue({code:'custom',message:'Duplicate memory relation'});
});

export function validateMemory(task:AgentTask,gateway:ModelGateway){
  gateway.validate(task);
  if(task.strategyVersion!==memoryConsolidationStrategy||task.request.schemaName!=='memory_consolidation'||!task.request.schema)throw new GatewayError('AGENT_CONFIG_CHANGED');
}

export async function executeMemory(task:AgentTask,gateway:ModelGateway,signal:AbortSignal){
  const response=await gateway.execute(task,signal);
  try{
    outputSchema.parse(JSON.parse(response.text));
  }catch{
    throw new GatewayError('LLM_INVALID_OUTPUT',response);
  }
  return response;
}
