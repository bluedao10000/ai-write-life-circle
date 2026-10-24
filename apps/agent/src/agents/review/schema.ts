import {z} from "zod";
// Go validates text limits by Unicode code point, source IDs by UTF-8 bytes.
// Keep this boundary compatible, including supplementary characters.
// eslint-disable-next-line no-control-regex -- Match Go unicode.IsSpace exactly.
const blank=/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const text=(max:number)=>z.string().refine(s=>!blank.test(s)&&Array.from(s).length<=max);
export const reviewCandidates=z.object({findings:z.array(z.object({
 type:z.enum(["character_consistency","timeline_consistency"]),title:text(120),inference:text(2000),question:text(1000),alternativeExplanation:text(1000),
 evidence:z.array(z.object({sourceId:z.string().min(1).refine(s=>Buffer.byteLength(s)<=200),quote:text(600)}).strict()).min(2).max(4),
}).strict()).max(20)}).strict();
