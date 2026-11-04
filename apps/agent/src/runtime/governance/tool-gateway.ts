import {withAbortSignal} from '@earendil-works/chord/context';
import type {ToolRegistration} from '@earendil-works/pi-durable';
import {Check} from 'typebox/value';
import type {TSchema} from 'typebox';
import {assertCurrent,audit,type ExecutionContext,type AuthorizationManager} from './runtime.js';
export type ToolPolicy={name:string;risk:'read'|'candidate'|'write';replay:'safe'|'unsafe';requiredScopes:readonly string[];maxInputBytes:number;maxOutputBytes:number;timeoutMs:number;idempotencyRequired:boolean};
export function governTool(tool:ToolRegistration,policy:ToolPolicy,execution:ExecutionContext,authority:AuthorizationManager):ToolRegistration {
 return {...tool,async execute(args,api,context){
  const signal=AbortSignal.any([execution.signal,AbortSignal.timeout(policy.timeoutMs),...(context.abortSignal?[context.abortSignal]:[])]);
  const current={...execution,signal};
  try{
   assertCurrent(current);
   if(policy.name!==tool.name||policy.replay!==tool.replay||policy.requiredScopes.some(scope=>!execution.scopes.includes(scope)))throw Error('AUTHORIZATION_REVOKED');
   if(Buffer.byteLength(JSON.stringify(args))>policy.maxInputBytes||!Check(tool.parameters as TSchema,args))throw Error('TOOL_EXECUTION_FAILED');
   await authority.authorize();assertCurrent(current);audit(current,'tool_started');
   const result=await tool.execute(args,api,withAbortSignal(signal,context));
   assertCurrent(current);
   if((result.output??[]).reduce((bytes,block)=>bytes+Buffer.byteLength(block.type==='text'?block.text:JSON.stringify(block)),0)>policy.maxOutputBytes)throw Error('TOOL_RESULT_TOO_LARGE');
   audit(current,'tool_finished');return result;
  }catch(error){audit(current,'failed');throw error}
 }};
}
