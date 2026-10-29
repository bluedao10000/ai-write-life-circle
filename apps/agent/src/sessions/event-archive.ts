import {lstatSync,readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {z} from "zod";
import {thinkingEventSchema, type ThinkingEvent} from "@writer-agent/contracts";

export const archiveThreshold=4000;
export const archiveBatch=2000;
const segmentSchema=z.object({
  schema:z.literal(1),sessionId:z.string(),firstId:z.number().int().positive(),lastId:z.number().int().positive(),
  events:z.array(thinkingEventSchema),
}).strict().refine(value=>value.events.length>0 && value.events[0]!.id===value.firstId && value.events.at(-1)!.id===value.lastId && value.events.every((event,index)=>index===0||event.id===value.events[index-1]!.id+1),{message:"ARCHIVE_SEQUENCE_INVALID"});
export type EventArchive=z.infer<typeof segmentSchema>;
export type ArchiveManifest={archivedThrough:number;segments:{firstId:number;lastId:number}[]};

function safeSegment(root:string,name:string):EventArchive {
  const path=join(root,name),stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024||(stat.mode&0o077)!==0)throw Error("SESSION_ARCHIVE_INVALID");
  return segmentSchema.parse(JSON.parse(readFileSync(path,"utf8")));
}

export function readEventArchive(root:string,id:string,manifest:ArchiveManifest,after=0):ThinkingEvent[] {
  const available=new Set(readdirSync(root));
  const out:ThinkingEvent[]=[];
  let previous=0;
  for(const segment of [...manifest.segments].sort((a,b)=>a.firstId-b.firstId)) {
    if(segment.firstId!==previous+1||segment.lastId<segment.firstId)throw Error("SESSION_ARCHIVE_INVALID");
    previous=segment.lastId;
    if(segment.lastId<=after)continue;
    const name=`${id}.${segment.firstId}-${segment.lastId}.events.json`;
    if(!available.has(name))throw Error("SESSION_ARCHIVE_MISSING");
    const archived=safeSegment(root,name);
    if(archived.sessionId!==id||archived.firstId!==segment.firstId||archived.lastId!==segment.lastId)throw Error("SESSION_ARCHIVE_INVALID");
    out.push(...archived.events.filter(event=>event.id>after));
  }
  if(previous!==manifest.archivedThrough)throw Error("SESSION_ARCHIVE_INVALID");
  return out;
}

export function archivePlan(s:{view:{sessionId:string;status:string};events:ThinkingEvent[];archive?:ArchiveManifest}) {
  if(s.view.status!=="idle"||s.events.length<=archiveThreshold)return undefined;
  const archived=s.archive?.archivedThrough??0;
  const pending=s.events.filter(event=>event.id>archived);
  if(pending.length<=archiveThreshold)return undefined;
  const events=pending.slice(0,archiveBatch);
  const firstId=(s.archive?.archivedThrough??0)+1;
  if(!events.length||events[0]!.id!==1&&events[0]!.id!==firstId||events.some((event,index)=>index>0&&event.id!==events[index-1]!.id+1))throw Error("SESSION_ARCHIVE_SEQUENCE_INVALID");
  const last=events.at(-1)!;
  return {value:{schema:1 as const,sessionId:s.view.sessionId,firstId:events[0]!.id,lastId:last.id,events},name:`${s.view.sessionId}.${events[0]!.id}-${last.id}.events.json`,remaining:pending.slice(archiveBatch)};
}
