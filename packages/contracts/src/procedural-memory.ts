import {z} from 'zod';
export const proceduralEvidenceSchema=z.object({taskId:z.string(),kind:z.string(),strategyVersion:z.string(),inputHash:z.string(),completedAt:z.string()}).strict();
export const proceduralRelationSchema=z.object({memoryId:z.string().min(1),memoryVersion:z.number().int().positive(),kind:z.enum(['duplicate','conflict','refinement']),reason:z.string().min(1).max(1000)}).strict();
export const proceduralResultVersionSchema=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const proceduralExtractionSourceSchema=z.object({taskId:z.string().min(1),resultVersion:proceduralResultVersionSchema}).strict();
export const proceduralRecordSchema=z.object({extractions:z.array(z.object({sessionId:z.string(),runId:z.string().min(1),sources:z.array(proceduralExtractionSourceSchema).max(4).optional(),provider:z.string(),model:z.string(),promptVersion:z.enum(["memory-extraction-v1","memory-extraction-v2","memory-extraction-v3","memory-consolidation-v1"]),authorizationVersion:z.number().int().nonnegative(),relations:z.array(proceduralRelationSchema).max(8).optional()}).strict()).max(8).optional(),id:z.string(),content:z.string().optional(),status:z.enum(['candidate','confirmed','rejected','deleted']),version:z.number().int().positive(),provenance:z.array(proceduralEvidenceSchema).optional(),supersedes:z.array(z.string()).min(1).max(7).optional(),supersededBy:z.string().optional(),createdAt:z.string(),updatedAt:z.string(),expiresAt:z.string().optional(),reviewedBy:z.string().optional()}).strict();
export const proceduralViewSchema=proceduralRecordSchema.extend({available:z.boolean(),unavailableReason:z.enum(['expired','not_confirmed','source_unavailable','superseded']).optional()});
export const proceduralCreateSchema=z.object({content:z.string().min(1).max(4000),taskIds:z.array(z.string()).min(1).max(8),expiresAt:z.string().optional()}).strict();
export const proceduralDecisionSchema=z.object({baseVersion:z.number().int().positive(),action:z.enum(['confirm','reject','delete'])}).strict();
export const proceduralListSchema=z.object({items:z.array(proceduralViewSchema)}).strict();
export const proceduralEvidenceListSchema=z.object({items:z.array(proceduralEvidenceSchema),limit:z.literal(100)}).strict();

export const proceduralMergeSchema=z.object({baseVersion:z.number().int().positive(),sources:z.array(z.object({id:z.string().min(1),baseVersion:z.number().int().positive()}).strict()).min(1).max(7)}).strict();
export const proceduralSupersedeSchema=z.object({baseVersion:z.number().int().positive(),replaces:z.array(z.object({id:z.string().min(1),baseVersion:z.number().int().positive()}).strict()).min(1).max(7)}).strict();

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
 version:proceduralResultVersionSchema,
 items:z.array(z.object({id:z.string(),kind:z.enum(['knowledge_observation','review_finding','creative_proposal','plan_assessment']),status:z.string(),text:z.string(),epistemic:z.string().optional(),feedback:z.string().optional()}).strict()).max(20),
 total:z.number().int().nonnegative(),
 truncated:z.boolean(),
}).strict();
