import {z} from 'zod';
export const proceduralEvidenceSchema=z.object({taskId:z.string(),kind:z.string(),strategyVersion:z.string(),inputHash:z.string(),completedAt:z.string()}).strict();
export const proceduralRecordSchema=z.object({id:z.string(),content:z.string().optional(),status:z.enum(['candidate','confirmed','rejected','deleted']),version:z.number().int().positive(),provenance:z.array(proceduralEvidenceSchema).optional(),createdAt:z.string(),updatedAt:z.string(),expiresAt:z.string().optional(),reviewedBy:z.string().optional()}).strict();
export const proceduralViewSchema=proceduralRecordSchema.extend({available:z.boolean(),unavailableReason:z.enum(['expired','not_confirmed','source_unavailable']).optional()});
export const proceduralCreateSchema=z.object({content:z.string().min(1).max(4000),taskIds:z.array(z.string()).min(1).max(8),expiresAt:z.string().optional()}).strict();
export const proceduralDecisionSchema=z.object({baseVersion:z.number().int().positive(),action:z.enum(['confirm','reject','delete'])}).strict();
export const proceduralListSchema=z.object({items:z.array(proceduralViewSchema)}).strict();
export const proceduralEvidenceListSchema=z.object({items:z.array(proceduralEvidenceSchema),limit:z.literal(100)}).strict();

export const proceduralMergeSchema=z.object({baseVersion:z.number().int().positive(),sources:z.array(z.object({id:z.string().min(1),baseVersion:z.number().int().positive()}).strict()).min(1).max(7)}).strict();

export const proceduralSourceSchema=z.object({
 evidence:proceduralEvidenceSchema,
 source:z.discriminatedUnion('type',[
  z.object({type:z.literal('chapter'),chapterId:z.string(),revisionId:z.string(),contentHash:z.string(),text:z.string().optional()}).strict(),
  z.object({type:z.literal('discussion'),sessionId:z.string(),messageId:z.string(),messages:z.array(z.object({messageId:z.string(),role:z.enum(['user','assistant']),text:z.string()}).strict())}).strict(),
 ]),
 truncated:z.boolean(),
}).strict();

export const proceduralOutcomeSchema=z.object({
 evidence:proceduralEvidenceSchema,
 basis:z.enum(['task_result','revision_observations']),
 version:z.number().int().nonnegative(),
 items:z.array(z.object({id:z.string(),kind:z.enum(['knowledge_observation','review_finding','creative_proposal','plan_assessment']),status:z.string(),text:z.string(),epistemic:z.string().optional(),feedback:z.string().optional()}).strict()).max(20),
 total:z.number().int().nonnegative(),
 truncated:z.boolean(),
}).strict();
