import type {AgentTask} from '@writer-agent/contracts';
import {ModelGateway} from '../runtime/model-gateway.js';
import {executeReview,validateReview} from '../agents/review/executor.js';
import {executeKnowledge,validateKnowledge} from '../agents/knowledge/executor.js';
import {executeCreative,validateCreative} from '../agents/creative/executor.js';
import {executeMemory,validateMemory} from '../agents/memory/executor.js';
import {executeAnalysis,validateAnalysis} from '../agents/analysis/executor.js';
export function validateTask(task:AgentTask,gateway:ModelGateway){if(task.kind==='review.execute')return validateReview(task,gateway);if(task.kind==='knowledge.extract')return validateKnowledge(task,gateway);if(task.kind==='creative.organize'||task.kind==='creative.plan_check')return validateCreative(task,gateway);if(task.kind==='memory.consolidate')return validateMemory(task,gateway);if(task.kind==='novel.analyze')return validateAnalysis(task,gateway);throw Error('UNSUPPORTED_TASK_KIND')}
export async function executeTask(task:AgentTask,gateway:ModelGateway,signal:AbortSignal){if(task.kind==='review.execute')return executeReview(task,gateway,signal);if(task.kind==='knowledge.extract')return executeKnowledge(task,gateway,signal);if(task.kind==='creative.organize'||task.kind==='creative.plan_check')return executeCreative(task,gateway,signal);if(task.kind==='memory.consolidate')return executeMemory(task,gateway,signal);if(task.kind==='novel.analyze')return executeAnalysis(task,gateway,signal);throw Error('UNSUPPORTED_TASK_KIND')}
