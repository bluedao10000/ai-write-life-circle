import {z} from 'zod';
export const categories=['task-success','reliability','memory','safety','performance'] as const;
export const assertionSchema=z.object({metric:z.string().min(1),operator:z.enum(['eq','gte','lte']),value:z.union([z.number().finite(),z.boolean(),z.string()])}).strict();
export const evaluationTaskSchema=z.object({
 taskId:z.string().regex(/^[a-z0-9-]+$/),category:z.enum(categories),capability:z.enum(['thinking','review','knowledge','creative']),difficulty:z.enum(['basic','boundary']),
 request:z.string().min(1).max(4000),environment:z.object({scenario:z.enum(['extraction-candidate','extraction-source-change','extraction-revoked','extraction-poison','answer','tool-denial','event-recovery','storage-sqlite','storage-outbox','discussion-memory','review-business','review-receipt','review-evidence','knowledge-business','creative-business','creative-plan-comparison','creative-plan-failure','knowledge-crash','knowledge-timeout','knowledge-memory','creative-expiry','procedural-revoke','procedural-expiry','procedural-delete','thinking-cancel','thinking-recovery','security-scope','security-parameter','security-resource','security-indirect','security-revoked','security-write-revoked']),fixture:z.literal('synthetic-v1'),initialState:z.object({events:z.number().int().min(0).max(100000).default(0),messages:z.number().int().min(0).max(100).default(0),scope:z.array(z.string()).default([])}).strict()}).strict(),
 stoppingCriteria:z.object({timeoutMs:z.number().int().min(100).max(120000),maxTokens:z.number().int().min(1).max(2000000),maxModelCalls:z.number().int().min(0).max(10),maxToolCalls:z.number().int().min(0).max(50)}).strict(),
 scorer:z.object({deterministic:z.array(assertionSchema).min(1),forbidden:z.array(assertionSchema),humanRubric:z.string().optional(),judgeRubric:z.string().optional()}).strict(),
}).strict();
export type EvaluationTask=z.infer<typeof evaluationTaskSchema>;
export type Category=typeof categories[number];
export type Observation={timings?:{memoryRetrievalMs:number[]};budgetExposure?:{tokens:number;authority:'go'|'thinking-durable'};metrics:Record<string,number|string|boolean|null>;trace:{action:string;name?:string}[];inputTokens:number|null;outputTokens:number|null;chargedTokens:number|null;modelCalls:number;toolCalls:number};
