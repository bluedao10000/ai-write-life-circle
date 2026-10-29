import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { thinkingSessionSchema, thinkingRunSchema } from "../../packages/contracts/src/thinking.js";

const idPattern = /^th-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const currentSavedSchema = z.object({
  schema: z.literal(1),
  accountingVersion: z.literal(2).optional(),
  owner: z.string(),
  epoch: z.number().int().nonnegative().optional(),
  executionLease: z.object({owner:z.string(),epoch:z.number().int().nonnegative(),expiresAt:z.number()}).strict().optional(),
  checkpoint: z.unknown().optional(),
  runs: z.array(thinkingRunSchema).optional(),
  deleted: z.boolean().optional(),
  view: thinkingSessionSchema,
  entries: z.array(z.unknown()),
  events: z.array(z.unknown()),
  requests: z.record(z.string(),z.object({fingerprint:z.string(),messageId:z.string()}).strict()),
}).strict();

// These are exactly the public and Saved fields parsed at 4dfdca1. Unknown
// fields fail closed so a future schema cannot silently lose durable evidence.
const legacyViewSchema = thinkingSessionSchema.omit({run:true,cancellationPending:true}).strict();
const legacySavedSchema = currentSavedSchema.omit({accountingVersion:true,epoch:true,executionLease:true,checkpoint:true,runs:true}).extend({view:legacyViewSchema,events:z.array(z.unknown())}).strict();

type CurrentSaved = z.infer<typeof currentSavedSchema>;
export type RollbackPiResult = {sessionId:string;terminalized:boolean;deleted:boolean;sha256:string};

function durableObject(root:string, name:string) {
  const path = join(root,name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024 || (stat.mode & 0o077) !== 0) throw Error(`UNSAFE_ROLLBACK_INPUT:${name}`);
  return path;
}

function writeDurable(path:string, value:unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp,"wx",0o600);
  try {
    writeFileSync(fd,JSON.stringify(value));
    fsyncSync(fd);
  } finally {closeSync(fd)}
  renameSync(tmp,path);
  const dir = openSync(resolve(path,".."),"r");
  try {fsyncSync(dir)} finally {closeSync(dir)}
}

export function rollbackPiSession(input:unknown, expectedId:string):{value:unknown;result:RollbackPiResult} {
  if (!idPattern.test(expectedId)) throw Error("INVALID_SESSION_ID");
  const source = currentSavedSchema.parse(input);
  if (source.view.sessionId !== expectedId || source.deleted && source.view.status !== "deleted") throw Error("ROLLBACK_SESSION_MISMATCH");
  const value = structuredClone(source) as CurrentSaved;
  const run = value.view.run;
  let terminalized = false;
  if (run) {
    const answerId = `${run.messageId}-answer${run.attempt > 1 ? `-${run.attempt}` : ""}`;
    const answer = value.view.messages.find(message => message.id === answerId && message.role === "assistant");
    if (!answer) throw Error("ROLLBACK_RUN_ANSWER_MISSING");
    const completed = answer.status === "completed" || run.status === "completed" || value.events.some(event => {
      const candidate = z.object({type:z.string(),messageId:z.string().optional()}).passthrough().safeParse(event);
      return candidate.success && candidate.data.type === "message_completed" && candidate.data.messageId === answer.id;
    });
    if (completed) {
      answer.status = "completed";
      delete answer.errorCode;
    } else if (run.status === "cancelled" || answer.status === "cancelled") {
      answer.status = "cancelled";
      answer.errorCode = "CANCELLED";
    } else if (run.status === "failed" || answer.status === "failed") {
      answer.status = "failed";
    } else {
      // Old Pi cannot resume a business checkpoint. Preserve accepted input and
      // partial output, but make the interrupted state explicit and terminal.
      answer.status = "interrupted";
      answer.errorCode = "AGENT_RESTARTED";
      terminalized = true;
    }
  } else {
    for (const message of value.view.messages) {
      if (message.status === "accepted" || message.status === "running") {
        message.status = "interrupted";
        message.errorCode = "AGENT_RESTARTED";
        terminalized = true;
      }
    }
  }
  // Old Store.recover only treats a running Session as unfinished. idle prevents
  // it from touching any earlier completed answer during restart.
  if (value.view.status === "running") terminalized = true;
  value.view.status = value.deleted ? "deleted" : "idle";
  delete value.accountingVersion;
  delete value.epoch;
  delete value.executionLease;
  delete value.checkpoint;
  delete value.runs;
  delete value.view.run;
  delete value.view.cancellationPending;
  const legacy = legacySavedSchema.parse(value);
  return {value:legacy,result:{sessionId:expectedId,terminalized,deleted:legacy.deleted===true,sha256:createHash("sha256").update(JSON.stringify(legacy)).digest("hex")}};
}

export function rollbackPiDirectory(source:string, output:string) {
  const src = resolve(source), dest = resolve(output);
  if (src === dest) throw Error("ROLLBACK_REQUIRES_SEPARATE_OUTPUT");
  const srcStat = lstatSync(src);
  if (!srcStat.isDirectory() || srcStat.isSymbolicLink() || (srcStat.mode & 0o077) !== 0) throw Error("UNSAFE_ROLLBACK_INPUT_DIRECTORY");
  if (existsSync(join(src,".process-lock")) || existsSync(join(src,".process-lock-admission"))) throw Error("STOP_PI_BEFORE_ROLLBACK");
  if (existsSync(dest)) throw Error("ROLLBACK_OUTPUT_ALREADY_EXISTS");
  mkdirSync(dest,{recursive:false,mode:0o700});
  chmodSync(dest,0o700);
  const results:RollbackPiResult[] = [];
  const sessions = new Set<string>(), tombstones = new Set<string>();
  try {
    for (const name of readdirSync(src).sort()) {
      if (name === ".process-lock" || name === ".process-lock-admission") continue;
      if (idPattern.test(name) && existsSync(join(src,`${name}.json`))) throw Error(`ROLLBACK_UNEXPECTED_SESSION_FILE:${name}`);
      if (name.endsWith(".json") && idPattern.test(name.slice(0,-5))) {
        const id = name.slice(0,-5);
        const converted = rollbackPiSession(JSON.parse(readFileSync(durableObject(src,name),"utf8")),id);
        writeDurable(join(dest,name),converted.value);
        // Reparse the actual output before reporting success.
        legacySavedSchema.parse(JSON.parse(readFileSync(join(dest,name),"utf8")));
        results.push(converted.result);
        sessions.add(id);
      } else if (name.endsWith(".json.deleted") && idPattern.test(name.slice(0,-13))) {
        copyFileSync(durableObject(src,name),join(dest,name));
        chmodSync(join(dest,name),0o600);
        tombstones.add(name.slice(0,-13));
      } else throw Error(`ROLLBACK_UNEXPECTED_STATE_ENTRY:${name}`);
    }
    if (!results.length) throw Error("ROLLBACK_NO_SESSIONS");
    for (const id of tombstones) {
      if (!sessions.has(id)) throw Error("ROLLBACK_TOMBSTONE_WITHOUT_SESSION");
      const saved = legacySavedSchema.parse(JSON.parse(readFileSync(join(dest,`${id}.json`),"utf8")));
      if (!saved.deleted || saved.view.status !== "deleted") throw Error("ROLLBACK_TOMBSTONE_STATE_MISMATCH");
      if (saved.view.messages.length || saved.events.length || saved.entries.length || Object.keys(saved.requests).length) throw Error("ROLLBACK_TOMBSTONE_CONTENT_RETAINED");
    }
    writeDurable(join(dest,"rollback-manifest.json"),{schema:1,sourceRevision:"thinking-reliability-v1",targetRevision:"4dfdca1",sessions:results});
    return results;
  } catch (error) {
    rmSync(dest,{recursive:true,force:true});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const args = process.argv.slice(2);
  const source = args[args.indexOf("--pi-state")+1], output = args[args.indexOf("--output")+1];
  if (args.length !== 4 || !args.includes("--pi-state") || !args.includes("--output") || !source || !output || source.startsWith("--") || output.startsWith("--")) throw Error("Usage: thinking-rollback.mts --pi-state /private/input --output /private/converted");
  const result = rollbackPiDirectory(source,output);
  console.log(JSON.stringify({event:"thinking_pi_rollback_prepared",sessions:result.length,terminalized:result.filter(row=>row.terminalized).length,output:resolve(output)}));
}
