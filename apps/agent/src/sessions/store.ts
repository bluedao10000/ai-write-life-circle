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
} from "@writer-agent/contracts";
export type Saved = {
  schema: 1;
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
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || (lstatSync(dir).mode & 0o077) !== 0)
      throw Error("UNSAFE_STATE_DIRECTORY");
    this.lock = join(dir, ".process-lock");
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
    rmSync(this.lock, { force: true });
  }
}
