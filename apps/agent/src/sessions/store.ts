import type {AuditRecord} from '../runtime/governance/runtime.js';
import type {WorkingMemory} from '../memory/working-memory.js';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, lstatSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { AssistantEntry, type Harness, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { thinkingSessionSchema, type ThinkingSession, type ThinkingEvent, type ThinkingExecutionInput, type ThinkingRun } from "@writer-agent/contracts";
import { failureFor } from "../runtime/reliability.js";
import { durableContext, interruptDurable, openDurable, ThinkingState, type DurableRuntime } from "../runtime/durable.js";
import { archiveBatch, archiveThreshold, iterateEventArchive, type ArchiveManifest } from "./event-archive.js";
import { EventStore } from "./event-store.js";
import { projectSnapshot, projectHistory } from "./projection.js";
import type { StoryWrites } from "../tools/registry.js";

export type ExecutionFence = {runId:string;owner:string;epoch:number};
export type ExecutionAuthority = {
  executionStatus(id:string, fence:ExecutionFence, now?:number): "current" | "expired" | "stale" | "deleted";
};
export type DurableRun = { conversationId: number; taskId?: number; submissionId?: number; projectedEntry?: number };
export type RunExecution = {
  audit?:AuditRecord[];
  governance?: {runtimeVersion:string;definitionVersion:number;toolSchemaVersion:number;promptVersion?:string;memorySchemaVersion?:number};
  calls: number; turns: number; memoryCalls: number; spent: number;
  modelRequests: {id:string;reservedTokens:number;bound:number;input?:number;output?:number;status:"reserved"|"settled"}[];
};
export type Saved = {
  discussionMemory?: WorkingMemory;
  archive?: ArchiveManifest;
  epoch?: number;
  executionLease?: {owner:string;epoch:number;expiresAt:number};
  runs?: ThinkingRun[];
  checkpoint?: { input: ThinkingExecutionInput; entries: unknown[]; messageId: string; storyWrites?: StoryWrites };
  durable?: DurableRun;
  execution?: RunExecution;
  attempts?: Record<string, {durable:DurableRun;execution:RunExecution}>;
  schema: 1;
  accountingVersion?: 2;
  owner: string;
  view: ThinkingSession;
  entries: unknown[];
  events: ThinkingEvent[];
  requests: Record<string, { fingerprint: string; messageId: string }>;
  deleted?: boolean;
};
export type ThinkingRunMetrics = {
  schemaVersion: 1;
  attempts: number;
  accepted: number;
  running: number;
  checkpointed: number;
  completed: number;
  failed: number;
  interrupted: number;
  cancelled: number;
  resumed: number;
  modelCalls: number;
  terminalSamples: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
};
export const idPattern = /^th-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Durable documents own mutable state; this cache exposes only completed commits. */
export type StoreOptions = {onPhase?: (phase:"state_committed"|"events_appended"|"migration_projected") => void | Promise<void>};
export class Store implements ExecutionAuthority {
  private lock: string;
  private closed = false;
  private closing?: Promise<void>;
  private readonly saved = new Map<string, Saved>();
  private readonly runtimes = new Map<string, Promise<DurableRuntime>>();
  private readonly projections = new Map<string, EventStore>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly failed = new Set<string>();
  private readonly unpublished = new Set<string>();
  private initialization: 'starting'|'ready'|'failed' = 'starting';
  readonly ready: Promise<void>;
  constructor(readonly dir: string, private readonly options:StoreOptions = {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || (lstatSync(dir).mode & 0o077) !== 0)
      throw Error("UNSAFE_STATE_DIRECTORY");
    this.lock = join(dir, ".process-lock");
    // Serialize stale-PID takeover as well as initial creation. Two starters must
    // never both unlink a lock that one has just replaced. A crashed admission
    // guard requires operator inspection, never age-based lock stealing.
    const guard = this.lock + "-admission";
    let admission: number;
    try {
      admission = openSync(guard, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw Error("AGENT_LOCK_ADMISSION_REQUIRED");
      throw e;
    }
    try {
      writeFileSync(admission, String(process.pid));
      try {
        const pid = Number(readFileSync(this.lock, "utf8"));
        try {
          process.kill(pid, 0);
          throw Error("AGENT_ALREADY_RUNNING");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
          rmSync(this.lock);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      writeFileSync(this.lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } finally {
      closeSync(admission);
      rmSync(guard);
    }
    this.ready = this.initialize().then(()=>{this.initialization='ready'}).catch(async error => {
      this.initialization='failed';
      await Promise.allSettled([...this.runtimes.values()].map(async runtime => (await runtime).harness.close(durableContext)));
      for (const projection of this.projections.values()) projection.close();
      this.closed = true;
      rmSync(this.lock, { force: true });
      throw error;
    });
  }
  path(id: string) {
    if (!idPattern.test(id)) throw Error("INVALID_SESSION_ID");
    return join(this.dir, id + ".sqlite");
  }
  health() {
    let sessions=0,recoveryPending=0,unknownUsageSessions=0;
    for(const value of this.saved.values()){
      if(value.deleted)continue;
      sessions++;
      if(value.view.run?.resumable&&['failed','interrupted'].includes(value.view.run.status))recoveryPending++;
      if(value.view.usage?.incomplete)unknownUsageSessions++;
    }
    return {state:this.initialization==='failed'?'failed' as const:this.closed||this.closing?'closed' as const:this.initialization,sessions,failedSessions:this.failed.size,unpublishedSessions:this.unpublished.size,recoveryPending,unknownUsageSessions};
  }
  runMetrics(): ThinkingRunMetrics {
    const result: ThinkingRunMetrics = {
      schemaVersion: 1, attempts: 0, accepted: 0, running: 0, checkpointed: 0,
      completed: 0, failed: 0, interrupted: 0, cancelled: 0, resumed: 0,
      modelCalls: 0, terminalSamples: 0, durationP50Ms: null, durationP95Ms: null,
    };
    const durations: number[] = [];
    const add = (run: ThinkingRun) => {
      result.attempts++;
      result[run.status]++;
      result.resumed += Number(run.attempt > 1);
      result.modelCalls += run.modelCalls;
      if (["completed", "failed", "interrupted", "cancelled"].includes(run.status)) {
        result.terminalSamples++;
        durations.push(run.durationMs);
      }
    };
    for (const saved of this.saved.values()) {
      if (saved.deleted) continue;
      for (const run of saved.runs ?? []) add(run);
      if (saved.view.run) add(saved.view.run);
    }
    if (durations.length) {
      durations.sort((a, b) => a - b);
      result.durationP50Ms = durations[Math.ceil(durations.length * 0.5) - 1]!;
      result.durationP95Ms = durations[Math.ceil(durations.length * 0.95) - 1]!;
    }
    return result;
  }
  private legacyPath(id: string) {
    this.path(id);
    return join(this.dir, id + ".json");
  }
  isDeleted(id: string) {
    return existsSync(this.legacyPath(id) + ".deleted");
  }
  markDeleted(id: string) {
    const path = this.legacyPath(id) + ".deleted";
    if (existsSync(path)) return;
    const fd = openSync(path, "wx", 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const d = openSync(this.dir, "r");
    try { fsyncSync(d); } finally { closeSync(d); }
  }
  private runtimeSaved(id: string): Promise<DurableRuntime> {
    if (this.closed) throw Error("SESSION_STORE_CLOSED");
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      const path = this.path(id);
      if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
      runtime = openDurable(path);
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }
  async runtime(id: string) {
    await this.ready;
    if (this.isDeleted(id)) throw Error("SESSION_DELETED");
    return this.runtimeSaved(id);
  }
  async harness(id: string): Promise<Harness> {
    return (await this.runtime(id)).harness;
  }
  private validate(value: Saved, id: string) {
    if (value.schema !== 1 || value.view.sessionId !== id) throw Error("SESSION_STORAGE_INVALID");
    thinkingSessionSchema.parse(value.view);
    if (value.accountingVersion !== 2) {
      if (!value.view.usage.incomplete) value.view.usage.charged = value.view.usage.input + value.view.usage.output;
      value.accountingVersion = 2;
    }
  }
  private eventStore(id:string) {
    let projection=this.projections.get(id);
    if(!projection){projection=new EventStore(join(this.dir,id+".events.sqlite"),id);this.projections.set(id,projection)}
    return projection;
  }
  private checkAvailable(id:string) {
    if(this.failed.has(id)&&!this.isDeleted(id))throw Error("SESSION_PROJECTION_FAILED");
  }
  private correlate(value:Saved) {
    const keys=new Map(Object.entries(value.requests).map(([key,receipt])=>[receipt.messageId,key]));
    for(const message of value.view.messages){const key=keys.get(message.id);if(message.role==="user"&&!message.requestKey&&key)message.requestKey=key;}
  }
  private async initialize() {
    const ids = new Set(readdirSync(this.dir).flatMap(file => {
      const match = /^(.*)\.(?:sqlite|json|json.deleted)$/.exec(file);
      return match && idPattern.test(match[1]!) ? [match[1]!] : [];
    }));
    for (const id of ids) {
      if (this.isDeleted(id)) { await this.purgeSaved(id); continue; }
      const runtime=await this.runtimeSaved(id),projection=this.eventStore(id);
      const document=await runtime.harness.snapshot(ThinkingState,durableContext);
      let value=document?.saved ? structuredClone(document.saved) as unknown as Saved : undefined;
      if(!value && existsSync(this.legacyPath(id))) {
        const path=this.legacyPath(id),stat=lstatSync(path);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw Error("SESSION_STORAGE_INVALID");
        value=JSON.parse(readFileSync(path,"utf8")) as Saved;
      }
      if(!value)continue;
      this.validate(value,id);this.correlate(value);
      if(value.deleted){this.markDeleted(id);await this.purgeSaved(id);continue}
      if(document?.layout!==2 || !document.saved) {
        if(value.archive)for(const events of iterateEventArchive(this.dir,id,value.archive))projection.append(events);
        for(let start=0;start<value.events.length;start+=archiveBatch)projection.append(value.events.slice(start,start+archiveBatch));
        projection.project([],value.view.messages);
        if(projection.cursor()!==value.view.cursor)throw Error("SESSION_EVENT_CURSOR_MISMATCH");
        await this.options.onPhase?.("migration_projected");
        value.events=[];delete value.archive;value.entries=[];
        if(value.checkpoint)value.checkpoint.entries=[];
        await runtime.harness.commit(async tx=>{
          const state=await tx.doc(ThinkingState);
          state.saved=value as unknown as JsonValue;state.layout=2;state.publishedCursor=value.view.cursor;state.outbox=[];
        },durableContext);
      } else {
        await this.publish(id,value,document.outbox??[]);
      }
      this.saved.set(id,value);
      // Sources remain available until both databases contain the migrated state.
      rmSync(this.legacyPath(id),{force:true});this.clearArchive(id);
      await interruptDurable(runtime.harness);
      const restored=this.read(id,false)!;
      await this.restoreAnswer(restored,runtime.harness);
      this.saved.set(id,{...restored,events:[]});
      // Recovery needs terminal markers added while reconstructing the answer.
      if(restored.events.some(event=>event.id>value.view.cursor))await this.commitSaved(restored);
    }
    await this.recoverSaved();
  }
  read(id:string,withEvents=true):Saved|undefined {
    this.path(id);this.checkAvailable(id);
    const value=this.saved.get(id);if(!value)return;
    const copy=structuredClone(value);this.validate(copy,id);
    if(!copy.deleted)copy.events=this.eventStore(id).read(withEvents?0:Math.max(0,copy.view.cursor-archiveThreshold),withEvents?100000:archiveThreshold,copy.view.cursor);
    return copy;
  }
  cursor(id:string) {this.checkAvailable(id);return this.saved.get(id)?.view.cursor??0;}
  state(id:string):Saved|undefined {
    this.path(id);this.checkAvailable(id);
    const value=this.saved.get(id);if(!value)return;
    const copy=structuredClone(value);this.validate(copy,id);return copy;
  }
  async waitPublished(id:string){await this.queues.get(id);this.checkAvailable(id);}
  snapshot(id:string,limit=40) {
    if(this.queues.has(id))throw Error("SESSION_PROJECTION_PENDING");
    this.path(id);this.checkAvailable(id);
    const value=this.saved.get(id);if(!value||value.deleted||this.isDeleted(id))return;
    const header={...value.view};
    // Message rows are read separately without cloning authoritative history.
    Reflect.deleteProperty(header,"messages");Reflect.deleteProperty(header,"history");
    return projectSnapshot(header,this.eventStore(id),limit);
  }
  history(id:string,before?:string,limit=80) {
    if(this.queues.has(id))throw Error("SESSION_PROJECTION_PENDING");
    this.checkAvailable(id);
    if(!this.saved.has(id)||this.saved.get(id)?.deleted||this.isDeleted(id))return;
    return projectHistory(this.eventStore(id),before,limit);
  }
  private async restoreAnswer(value: Saved, harness: Harness) {
    if (value.view.status !== "running" || !value.view.run || !value.durable?.submissionId) return;
    const submission = await harness.submission(value.durable.submissionId as SubmissionId, durableContext);
    const receipt = await submission?.status(durableContext);
    if (receipt?.status !== "done" || receipt.type === "write") return;
    const entry = await harness.commit(tx => tx.entry(AssistantEntry, receipt.answer), durableContext);
    const answer = value.view.messages.find(message => message.id === value.view.run!.messageId + "-answer" + (value.view.run!.attempt > 1 ? "-" + value.view.run!.attempt : ""));
    if (!answer) return;
    const model = entry?.model?.find(message => message.role === "assistant");
    if (model?.role !== "assistant" || model.stopReason !== "stop") return;
    if (!answer.text && model?.role === "assistant") answer.text = model.content.filter(item => item.type === "text").map(item => item.text).join("");
    if (!answer.text.trim()) return;
    answer.status = "completed";
    answer.usage = {...value.view.usage};
    value.view.run.stepType = "completed";
    value.durable.projectedEntry = receipt.answer;
    delete answer.errorCode;
    if (!value.events.some(event => event.type === "message_completed" && event.messageId === answer.id)) {
      value.events.push({ id: ++value.view.cursor, type: "message_completed", messageId: answer.id });
      value.events.push({ id: ++value.view.cursor, type: "sources", messageId: answer.id, sources: answer.sources });
    }
  }
  readEvents(id:string,after=0,limit=200) {
    this.path(id);this.checkAvailable(id);
    const value=this.saved.get(id);if(!value)return;
    return {deleted:value.deleted,view:this.snapshot(id)??structuredClone(value.view),events:value.deleted?[]:this.eventStore(id).read(after,limit,value.view.cursor)};
  }
  executionStatus(id:string, fence:ExecutionFence, now=Date.now()) {
    this.checkAvailable(id);
    if (this.isDeleted(id)) return "deleted" as const;
    const current = this.saved.get(id);
    if (current?.deleted) return "deleted" as const;
    const lease = current?.executionLease;
    if (!current || current.view.run?.runId !== fence.runId || current.epoch !== fence.epoch || lease?.owner !== fence.owner || lease.epoch !== fence.epoch) return "stale" as const;
    return lease.expiresAt <= now ? "expired" as const : "current" as const;
  }
  async readTransaction(tx: Tx): Promise<Saved | undefined> {
    const document = await tx.doc(ThinkingState);
    return document.saved ? JSON.parse(JSON.stringify(document.saved)) as Saved : undefined;
  }
  async write<T = void>(value: Saved, mutate?: (tx: Tx) => T | Promise<T>, expectedFence?: ExecutionFence): Promise<T | undefined> {
    await this.ready;
    return this.commitSaved(value, mutate, expectedFence);
  }
  private async commitSaved<T>(value:Saved,mutate?:(tx:Tx)=>T|Promise<T>,expectedFence?:ExecutionFence):Promise<T|undefined> {
    const id=value.view.sessionId;
    const previous=this.queues.get(id)??Promise.resolve();
    const pending=previous.catch(()=>{}).then(()=>this.commitState(value,mutate,expectedFence));
    this.queues.set(id,pending);
    try{return await pending}finally{if(this.queues.get(id)===pending)this.queues.delete(id)}
  }
  private async publish(id:string,value:Saved,events:ThinkingEvent[]) {
    const projection=this.eventStore(id),runtime=await this.runtimeSaved(id);
    projection.project(events,value.view.messages);
    if(projection.cursor()!==value.view.cursor)throw Error("SESSION_EVENT_CURSOR_MISMATCH");
    await this.options.onPhase?.("events_appended");
    await runtime.harness.commit(async tx=>{
      const document=await tx.doc(ThinkingState);
      document.outbox=[];document.publishedCursor=value.view.cursor;
    },durableContext);
  }
  private async commitState<T>(value:Saved,mutate?:(tx:Tx)=>T|Promise<T>,expectedFence?:ExecutionFence):Promise<T|undefined> {
    const id=value.view.sessionId;this.checkAvailable(id);
    if(this.isDeleted(id)&&!value.deleted)throw Error("SESSION_DELETED");
    const runtime=await this.runtimeSaved(id);
    let committed!:Saved,pendingEvents:ThinkingEvent[]=[],prepared=false;
    const result=await runtime.harness.commit(async tx=>{
      if(this.isDeleted(id)&&!value.deleted)throw Error("SESSION_DELETED");
      const document=await tx.doc(ThinkingState);
      const previous=document.saved?JSON.parse(JSON.stringify(document.saved)) as Saved:null;
      if(expectedFence){
        const lease=previous?.executionLease;
        if(previous?.deleted)throw Error("SESSION_DELETED");
        if(!previous||previous.view.run?.runId!==expectedFence.runId||previous.epoch!==expectedFence.epoch||lease?.owner!==expectedFence.owner||lease.epoch!==expectedFence.epoch)throw Error("SESSION_INTERRUPTED");
        if(lease.expiresAt<=Date.now())throw Error(previous.view.run.stepType==="tool"?"TOOL_TIMEOUT":"DURATION_EXCEEDED");
      }
      const result=await mutate?.(tx);
      // Copy only state and this commit's new events, never the historical event list.
      const {events,...state}=value;
      committed=JSON.parse(JSON.stringify({...state,events:[]})) as Saved;
      delete committed.archive;this.correlate(committed);
      const cursor=previous?.view.cursor??0;
      this.eventStore(id).verifyReplay(events.filter(event=>event.id<=cursor));
      pendingEvents=JSON.parse(JSON.stringify(events.filter(event=>event.id>cursor))) as ThinkingEvent[];
      if(!committed.deleted){
        if(pendingEvents.some((event,index)=>event.id!==cursor+index+1)||committed.view.cursor!==cursor+pendingEvents.length)throw Error("SESSION_EVENT_CURSOR_MISMATCH");
      }
      if(Buffer.byteLength(JSON.stringify(committed))>32*1024*1024||Buffer.byteLength(JSON.stringify(pendingEvents))>32*1024*1024)throw Error("SESSION_STORAGE_LIMIT");
      document.saved=committed as unknown as JsonValue;document.layout=2;document.outbox=pendingEvents;
      prepared=true;
      return result;
    },durableContext).catch(error=>{if(prepared)this.failed.add(id);throw error});
    try {
      await this.options.onPhase?.("state_committed");
      if(!committed.deleted)await this.publish(id,committed,pendingEvents);
      this.saved.set(id,committed);
    } catch(error){this.failed.add(id);this.unpublished.add(id);throw error}
    return result;
  }
  async recover() {
    await this.ready;
    await this.recoverSaved();
  }
  private async recoverSaved() {
    for (const id of this.saved.keys()) {
      let s = this.read(id, false);
      if (!s) continue;
      if (s.deleted || this.isDeleted(s.view.sessionId)) {
        s.deleted = true;
        s.view.status = "deleted";
        s.view.messages = [];
        s.events = [];
        s.entries = [];
        s.requests = {};
        delete s.discussionMemory;
        delete s.archive;
        delete s.executionLease;
        delete s.runs;
        delete s.checkpoint;
        delete s.durable;
        delete s.execution;
        delete s.attempts;
        delete s.view.run;
        this.saved.set(id, structuredClone(s));
        await this.purgeSaved(id);
        continue;
      }
      if (s.view.status !== "running") continue;
      s = this.read(id,false)!;
      const run = s.view.run;
      const authorMessage = s.view.messages.find(m=>m.id===run?.messageId && m.role==="user");
      if(authorMessage?.storyRecording?.status==="saving") authorMessage.storyRecording={...authorMessage.storyRecording,status:"unknown",code:"OUTCOME_UNKNOWN"};
      const answerId = run ? run.messageId + "-answer" + (run.attempt > 1 ? "-" + run.attempt : "") : undefined;
      const answer = answerId ? s.view.messages.find(m=>m.role==="assistant" && m.id===answerId) : [...s.view.messages].reverse().find(m=>m.role==="assistant");
      const completed = answer?.status === "completed" || run?.status === "completed" ||
        (answer && s.events.some(e=>e.type==="message_completed" && e.messageId===answer.id));
      const terminal = completed ? "completed" : answer && ["failed","cancelled","interrupted"].includes(answer.status) ? answer.status : run && ["failed","cancelled","interrupted"].includes(run.status) ? run.status : undefined;
      delete s.executionLease;
      s.epoch = (s.epoch ?? 0) + 1;
      if (completed) {
        if (answer) {answer.status="completed";delete answer.errorCode}
        if (run) {run.status="completed";run.resumable=false;delete run.failure}
      } else if (terminal === "failed" || terminal === "cancelled") {
        if (run) {run.status=terminal;if(terminal==="cancelled")run.resumable=false}
      } else {
        if (answer) {answer.status="interrupted";answer.errorCode="AGENT_RESTARTED"}
        if (run) {run.status="interrupted";run.failure=failureFor("SESSION_INTERRUPTED",run.modelCalls>0)}
        s.events.push({id:++s.view.cursor,type:"error",messageId:answer?.id,code:"AGENT_RESTARTED"});
      }
      if (run) run.updatedAt=new Date().toISOString();
      s.view.status="idle";
      if (!s.events.some(e=>e.type==="session_completed" && e.messageId===answer?.id))
        s.events.push({id:++s.view.cursor,type:"session_completed",messageId:answer?.id});

      await this.commitSaved(s);
    }
  }
  clearArchive(id:string) {
    const prefix = id + ".";
    for (const file of readdirSync(this.dir)) {
      if (file.startsWith(prefix) && file.endsWith(".events.json")) rmSync(join(this.dir, file));
    }
  }
  async purge(id: string) {
    await this.ready;
    await this.purgeSaved(id);
  }
  private async purgeSaved(id: string) {
    await this.queues.get(id)?.catch(()=>{});
    const current=this.saved.get(id);
    if(current)this.saved.set(id,{schema:1,accountingVersion:2,owner:current.owner,deleted:true,entries:[],events:[],requests:{},view:{...current.view,status:"deleted",messages:[],run:undefined}});
    this.failed.delete(id);
    this.unpublished.delete(id);
    const projection=this.projections.get(id);
    if(projection){projection.close();this.projections.delete(id)}
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await (await runtime).harness.close(durableContext);
      this.runtimes.delete(id);
    }
    for (const path of [this.path(id), this.path(id) + "-wal", this.path(id) + "-shm", this.legacyPath(id),join(this.dir,id+".events.sqlite"),join(this.dir,id+".events.sqlite-wal"),join(this.dir,id+".events.sqlite-shm")]) rmSync(path, { force: true });
    this.clearArchive(id);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.ready;
      this.closed = true;
      await Promise.all([...this.runtimes.values()].map(async runtime => (await runtime).harness.close(durableContext)));
      this.runtimes.clear();
      for(const projection of this.projections.values())projection.close();
      this.projections.clear();
      rmSync(this.lock, { force: true });
    })();
    return this.closing;
  }
}
