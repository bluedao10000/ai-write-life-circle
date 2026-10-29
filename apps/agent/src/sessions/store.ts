import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
  thinkingSessionSchema,
  type ThinkingSession,
  type ThinkingEvent,
  type ThinkingExecutionInput,
  type ThinkingRun,
} from "@writer-agent/contracts";
import { failureFor } from "../runtime/reliability.js";
export type Saved = {
  epoch?: number;
  executionLease?: {owner:string;epoch:number;expiresAt:number};
  runs?: ThinkingRun[];
  checkpoint?: { input: ThinkingExecutionInput; entries: FileEntry[]; messageId: string };
  schema: 1;
  accountingVersion?: 2;
  owner: string;
  view: ThinkingSession;
  entries: FileEntry[];
  events: ThinkingEvent[];
  requests: Record<string, { fingerprint: string; messageId: string }>;
  deleted?: boolean;
};
export const idPattern =
  /^th-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class Store {
  private lock: string;
  private closed = false;
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
  }
  path(id: string) {
    if (!idPattern.test(id)) throw Error("INVALID_SESSION_ID");
    return join(this.dir, id + ".json");
  }
  isDeleted(id: string) {
    return existsSync(this.path(id) + ".deleted");
  }
  markDeleted(id: string) {
    const path = this.path(id) + ".deleted";
    if (!existsSync(path)) {
      const fd = openSync(path, "wx", 0o600);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const d = openSync(this.dir, "r");
      try {
        fsyncSync(d);
      } finally {
        closeSync(d);
      }
    }
  }
  read(id: string): Saved | undefined {
    const path = this.path(id);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isFile() || st.size > 32 * 1024 * 1024)
        throw Error("SESSION_STORAGE_INVALID");
      const value = JSON.parse(readFileSync(path, "utf8")) as Saved;
      if (value.schema !== 1 || value.view.sessionId !== id)
        throw Error("SESSION_STORAGE_INVALID");
      thinkingSessionSchema.parse(value.view);
      // Legacy charged was the sum of reservations, even when every usage report
      // was known. Settle only that provable over-reservation; unknown costs stay held.
      if (value.accountingVersion !== 2) {
        if (!value.view.usage.incomplete) value.view.usage.charged = value.view.usage.input + value.view.usage.output;
        value.accountingVersion = 2;
      }
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }
  write(value: Saved) {
    if (this.isDeleted(value.view.sessionId) && !value.deleted)
      throw Error("SESSION_DELETED");
    const path = this.path(value.view.sessionId),
      tmp = path + "." + randomUUID() + ".tmp";
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const d = openSync(this.dir, "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  }
  recover() {
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json") || !idPattern.test(file.slice(0, -5)))
        continue;
      const s = this.read(file.slice(0, -5));
      if (!s || s.deleted) continue;
      if (this.isDeleted(s.view.sessionId)) {
        s.deleted = true;
        s.view.status = "deleted";
        s.view.messages = [];
        s.events = [];
        s.entries = [];
        s.requests = {};
        delete s.executionLease;
        delete s.runs;
        delete s.checkpoint;
        delete s.view.run;
        this.write(s);
        continue;
      }
      if (s.view.status !== "running") continue;
      for (const m of s.view.messages) {
        if (m.status === "accepted" || m.status === "running") {
          m.status = "interrupted";
          m.errorCode = "AGENT_RESTARTED";
        }
      }
      delete s.executionLease;
      s.epoch = (s.epoch ?? 0) + 1;
      if (s.view.run) {
        s.view.run.status = "interrupted";
        s.view.run.failure = failureFor("SESSION_INTERRUPTED", s.view.run.modelCalls > 0);
        s.view.run.updatedAt = new Date().toISOString();
      }
      s.view.status = "idle";
      s.events.push({
        id: ++s.view.cursor,
        type: "error",
        code: "AGENT_RESTARTED",
      });
      this.write(s);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    rmSync(this.lock, { force: true });
  }
}
