import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, lstatSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { AssistantEntry, type Harness, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { thinkingSessionSchema, type ThinkingSession, type ThinkingEvent, type ThinkingExecutionInput, type ThinkingRun } from "@writer-agent/contracts";
import { failureFor } from "../runtime/reliability.js";
import { durableContext, interruptDurable, openDurable, ThinkingState, type DurableRuntime } from "../runtime/durable.js";
import { archiveBatch, archiveThreshold, readEventArchive, type ArchiveManifest } from "./event-archive.js";
import type { StoryWrites } from "../tools/registry.js";

export type ExecutionFence = {runId:string;owner:string;epoch:number};
export type ExecutionAuthority = {
  executionStatus(id:string, fence:ExecutionFence, now?:number): "current" | "expired" | "stale" | "deleted";
};
export type DurableRun = { conversationId: number; taskId?: number; submissionId?: number; projectedEntry?: number };
export type RunExecution = {
  calls: number; turns: number; memoryCalls: number; spent: number;
  modelRequests: {id:string;reservedTokens:number;bound:number;input?:number;output?:number;status:"reserved"|"settled"}[];
};
export type Saved = {
  discussionMemory?: {through:number;summary:string};
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
export const idPattern = /^th-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Durable documents own mutable state; this cache exposes only completed commits. */
export class Store implements ExecutionAuthority {
  private lock: string;
  private closed = false;
  private closing?: Promise<void>;
  private readonly saved = new Map<string, Saved>();
  private readonly runtimes = new Map<string, Promise<DurableRuntime>>();
  readonly ready: Promise<void>;
  constructor(readonly dir: string) {
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
    this.ready = this.initialize().catch(async error => {
      await Promise.allSettled([...this.runtimes.values()].map(async runtime => (await runtime).harness.close(durableContext)));
      this.closed = true;
      rmSync(this.lock, { force: true });
      throw error;
    });
  }
  path(id: string) {
    if (!idPattern.test(id)) throw Error("INVALID_SESSION_ID");
    return join(this.dir, id + ".sqlite");
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
  private async initialize() {
    const ids = new Set(readdirSync(this.dir).flatMap(file => {
      const match = /^(.*)\.(?:sqlite|json)$/.exec(file);
      return match && idPattern.test(match[1]!) ? [match[1]!] : [];
    }));
    for (const id of ids) {
      if (this.isDeleted(id)) { await this.purgeSaved(id); continue; }
      const runtime = await this.runtimeSaved(id);
      const document = await runtime.harness.snapshot(ThinkingState, durableContext);
      let value = document?.saved ? structuredClone(document.saved) as unknown as Saved : undefined;
      if (!value && existsSync(this.legacyPath(id))) {
        const path = this.legacyPath(id), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw Error("SESSION_STORAGE_INVALID");
        value = JSON.parse(readFileSync(path, "utf8")) as Saved;
        this.validate(value, id);
        if (value.archive) value.events = [...readEventArchive(this.dir, id, value.archive), ...value.events];
        delete value.archive;
        value.entries = [];
        if (value.checkpoint) value.checkpoint.entries = [];
        await this.commitSaved(value);
      }
      if (value) {
        this.validate(value, id);
        await this.restoreAnswer(value, runtime.harness);
        this.saved.set(id, value);
      }
      await interruptDurable(runtime.harness);
      // The committed document is the only mutable authority after import.
      rmSync(this.legacyPath(id), { force: true });
      this.clearArchive(id);
    }
    await this.recoverSaved();
  }
  read(id: string, withEvents = true): Saved | undefined {
    this.path(id);
    const value = this.saved.get(id);
    if (!value) return;
    const copy = structuredClone(value);
    this.validate(copy, id);
    if (!withEvents) copy.events = copy.events.slice(-archiveThreshold);
    return copy;
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
  readEvents(id: string, after = 0) {
    const value = this.read(id, false);
    if (!value) return;
    value.events = structuredClone(this.saved.get(id)!.events.filter(event => event.id > after));
    return value;
  }
  executionStatus(id:string, fence:ExecutionFence, now=Date.now()) {
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
  private async commitSaved<T>(value: Saved, mutate?: (tx: Tx) => T | Promise<T>, expectedFence?: ExecutionFence): Promise<T | undefined> {
    if (this.isDeleted(value.view.sessionId) && !value.deleted) throw Error("SESSION_DELETED");
    const runtime = await this.runtimeSaved(value.view.sessionId);
    let committed!: Saved;
    const result = await runtime.harness.commit(async tx => {
      if (this.isDeleted(value.view.sessionId) && !value.deleted) throw Error("SESSION_DELETED");
      const document = await tx.doc(ThinkingState);
      const previous = document.saved ? JSON.parse(JSON.stringify(document.saved)) as Saved : null;
      if (expectedFence) {
        const lease = previous?.executionLease;
        if (previous?.deleted) throw Error("SESSION_DELETED");
        if (!previous || previous.view.run?.runId !== expectedFence.runId || previous.epoch !== expectedFence.epoch || lease?.owner !== expectedFence.owner || lease.epoch !== expectedFence.epoch) throw Error("SESSION_INTERRUPTED");
        if (lease.expiresAt <= Date.now()) throw Error(previous.view.run.stepType === "tool" ? "TOOL_TIMEOUT" : "DURATION_EXCEEDED");
      }
      const result = await mutate?.(tx);
      committed = JSON.parse(JSON.stringify(value)) as Saved;
      if (!committed.deleted && previous && committed.events[0]?.id > 1) {
        const first = committed.events[0]!.id;
        committed.events = [...previous.events.filter(event => event.id < first), ...committed.events];
      }
      delete committed.archive;
      // SQLite retains the complete history; capacity follows the legacy main
      // document and event segments rather than their combined serialized size.
      const recentStart = Math.max(0, committed.events.length - archiveThreshold);
      const withinLimit = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024 * 1024;
      if (!withinLimit({...committed, events:committed.events.slice(recentStart)})) throw Error("SESSION_STORAGE_LIMIT");
      for (let start = 0; start < recentStart; start += archiveBatch) {
        const events = committed.events.slice(start, Math.min(start + archiveBatch, recentStart));
        if (!withinLimit({schema:1,sessionId:committed.view.sessionId,firstId:events[0]!.id,lastId:events.at(-1)!.id,events}))
          throw Error("SESSION_STORAGE_LIMIT");
      }
      document.saved = committed as unknown as JsonValue;
      return result;
    }, durableContext);
    this.saved.set(value.view.sessionId, committed);
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
      s = this.read(id)!;
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
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await (await runtime).harness.close(durableContext);
      this.runtimes.delete(id);
    }
    for (const path of [this.path(id), this.path(id) + "-wal", this.path(id) + "-shm", this.legacyPath(id)]) rmSync(path, { force: true });
    this.clearArchive(id);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.ready;
      this.closed = true;
      await Promise.all([...this.runtimes.values()].map(async runtime => (await runtime).harness.close(durableContext)));
      this.runtimes.clear();
      rmSync(this.lock, { force: true });
    })();
    return this.closing;
  }
}
