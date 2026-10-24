import type {AgentTask} from '@writer-agent/contracts';
import {ModelGateway} from '../runtime/model-gateway.js';
import {executeReview,validateReview} from '../agents/review/executor.js';
import {executeKnowledge,validateKnowledge} from '../agents/knowledge/executor.js';
export function validateTask(task:AgentTask,gateway:ModelGateway){if(task.kind==='review.execute')return validateReview(task,gateway);if(task.kind==='knowledge.extract')return validateKnowledge(task,gateway);throw Error('UNSUPPORTED_TASK_KIND')}
export async function executeTask(task:AgentTask,gateway:ModelGateway,signal:AbortSignal){if(task.kind==='review.execute')return executeReview(task,gateway,signal);if(task.kind==='knowledge.extract')return executeKnowledge(task,gateway,signal);throw Error('UNSUPPORTED_TASK_KIND')}
