import { z } from "zod";
export const agentTaskProtocol = "agent-tasks-v1" as const;
export const agentTaskModelSchema = z.object({provider:z.string(),model:z.string(),endpoint:z.string().url(),execution:z.enum(["local","external"])}).strict();
export const agentModelRequestSchema=z.object({outputLimit:z.number().int().min(128).max(32768).optional(),system:z.string().max(40000),input:z.string().max(256*1024),schemaName:z.string().max(80),schema:z.record(z.string(),z.unknown())}).strict();
export const agentModelResponseSchema=z.object({text:z.string().max(512*1024),usage:z.object({cachedInputTokens: z.number().int().nonnegative().optional(), inputTokens:z.number().int().min(0).max(1000000),outputTokens:z.number().int().min(0).max(131072)}).strict().nullable(),modelCalls:z.number().int().positive().max(5).optional()}).strict();
export const agentTaskSchema=z.object({
 taskId:z.string().uuid(),kind:z.enum(["review.execute","knowledge.extract","creative.organize","creative.plan_check","memory.consolidate"]),bookId:z.string().min(1).max(128),authorId:z.string().min(1).max(128),leaseToken:z.string().uuid(),executorEpoch:z.number().int().positive(),attempt:z.number().int().min(1).max(3),deadline:z.string().datetime({offset:true}),strategyVersion:z.string(),revisionId:z.string(),contentHash:z.string(),inputHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),model:agentTaskModelSchema,configFingerprint:z.string().max(5000),outputSchemaVersion:z.enum(["review-candidates-v1","knowledge-candidates-v1","creative-organize-candidates-v1","creative-plan_check-candidates-v1","creative-plan-check-candidates-v2","memory-candidate-v1"]),reservedTokens:z.number().int().nonnegative(),budgetDay:z.string(),consent:z.record(z.string(),z.unknown()),request:agentModelRequestSchema
}).strict();
export const agentTaskClaimSchema=z.object({instance:z.string().min(1).max(128),configFingerprint:z.string().max(5000),kinds:z.array(z.enum(["review","knowledge","creative","memory"])).min(1).max(4).optional(),contracts:z.record(z.string(),z.string().regex(/^sha256:[a-f0-9]{64}$/))}).strict();
export const agentTaskClaimResultSchema=z.object({task:agentTaskSchema.nullable()}).strict();
export const agentTaskEnvelopeSchema=z.object({leaseToken:z.string().uuid(),executorEpoch:z.number().int().positive(),attempt:z.number().int().min(1).max(3),kind:agentTaskSchema.shape.kind,inputHash:agentTaskSchema.shape.inputHash,instance:z.string().min(1).max(128),response:agentModelResponseSchema,failureCode:z.string().regex(/^[A-Z_]{1,80}$/).optional()}).strict();
export const agentTaskAcknowledgementSchema=z.object({acknowledged:z.literal(true)}).strict();
export type AgentTask=z.infer<typeof agentTaskSchema>;
export type AgentModelResponse=z.infer<typeof agentModelResponseSchema>;
export type AgentTaskEnvelope=z.infer<typeof agentTaskEnvelopeSchema>;

export const agentWorkerHeartbeatSchema=z.object({instance:z.string().min(1).max(128),version:z.string().min(1).max(128),configFingerprint:z.string().max(5000),kinds:z.array(z.enum(["review","knowledge","creative","memory"])).min(1).max(4),activeTasks:z.array(z.string().uuid()).max(8),ready:z.boolean()}).strict();

export const agentTaskDiagnosticsSchema=z.object({schemaVersion:z.literal(1),taskId:z.string().uuid(),bookId:z.string(),kind:agentTaskSchema.shape.kind,strategyVersion:z.string(),outputSchemaVersion:agentTaskSchema.shape.outputSchemaVersion,executorEpoch:z.number().int().positive(),attempt:z.number().int().positive(),deadline:z.string().datetime({offset:true}),started:z.boolean(),finished:z.boolean(),outcome:z.enum(['accepted','running','completed','failed','cancelled','interrupted','unknown']),completedAt:z.string().datetime({offset:true}).optional(),sourceTaskIds:z.array(z.string()).max(4)}).strict();
