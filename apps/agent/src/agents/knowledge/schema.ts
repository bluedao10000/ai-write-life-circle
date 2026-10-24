import {z} from 'zod';
// Match Go byte bounds; final identities, evidence, merges and corrections remain Go-owned.
// eslint-disable-next-line no-control-regex -- Match Go unicode.IsSpace, including BOM behavior.
const blank=/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const text=(max:number)=>z.string().refine(s=>!blank.test(s)&&Buffer.byteLength(s)<=max);
const optional=(max:number)=>z.string().refine(s=>Buffer.byteLength(s)<=max).nullish();
export const knowledgeCandidates=z.object({entities:z.array(z.object({key:text(100),type:z.enum(['character','place','organization','world_rule','event','plot_line','foreshadowing']),name:text(120),aliases:z.array(text(120)).max(10),identity:z.string().refine(s=>Buffer.byteLength(s)<=400),existingEntityId:z.string().nullish()}).strict()).max(40),assertions:z.array(z.object({entityKey:z.string(),predicate:text(100),text:text(1500),targetKey:z.string().nullish(),epistemic:z.enum(['observation','claim','inference']),sourceKind:z.enum(['narration','dialogue','thought']),speaker:optional(120),time:optional(200),quote:text(1800)}).strict()).max(120)}).strict();
