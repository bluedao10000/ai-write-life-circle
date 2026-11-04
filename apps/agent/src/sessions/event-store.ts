import {closeSync, existsSync, openSync} from "node:fs";
import {DatabaseSync, type StatementSync} from "node:sqlite";
import type {ThinkingEvent, ThinkingMessage} from "@writer-agent/contracts";
import {canonicalJSON} from "../runtime/fingerprint.js";

export const eventPageLimit = 100000;
export const eventSegmentCount = 2000;
export const eventByteLimit = 32 * 1024 * 1024;
export const messageReadLimit = 1000;
type EventRow = {payload:string};
type Metadata = {session_id:string;cursor:number};
type Segment = {segment_id:number;event_count:number;bytes:number};

function bounded(value:number, maximum:number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error("INVALID_READ_LIMIT");
  return value;
}

/** Indexed event history and rebuildable message projection. Durable owns unacknowledged events. */
export class EventStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string,StatementSync>();
  private closed = false;
  constructor(readonly path:string, readonly sessionId:string) {
    if (!existsSync(path)) closeSync(openSync(path,"wx",0o600));
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS thinking_event_metadata (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), session_id TEXT NOT NULL, cursor INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS thinking_event_segments (
          segment_id INTEGER PRIMARY KEY, first_cursor INTEGER NOT NULL, last_cursor INTEGER NOT NULL,
          event_count INTEGER NOT NULL, bytes INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS thinking_events (
          cursor INTEGER PRIMARY KEY, session_id TEXT NOT NULL, event_type TEXT NOT NULL,
          payload TEXT NOT NULL, segment_id INTEGER NOT NULL REFERENCES thinking_event_segments(segment_id)
        );
        CREATE TABLE IF NOT EXISTS thinking_messages (
          message_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL
        );`);
      this.statement("INSERT OR IGNORE INTO thinking_event_metadata VALUES(1,?,0)").run(sessionId);
      if (this.metadata().session_id !== sessionId) throw Error("EVENT_SESSION_MISMATCH");
    } catch (error) { this.db.close(); throw error; }
  }
  private statement(sql:string) {
    if (this.closed) throw Error("EVENT_STORE_CLOSED");
    let statement = this.statements.get(sql);
    if (!statement) {statement=this.db.prepare(sql);this.statements.set(sql,statement);}
    return statement;
  }
  private metadata() {
    return this.statement("SELECT session_id,cursor FROM thinking_event_metadata WHERE singleton=1").get() as Metadata;
  }
  cursor() {return this.metadata().cursor;}
  count() {return this.cursor();}
  append(events:readonly ThinkingEvent[]) {this.project(events);}
  verifyReplay(events:readonly ThinkingEvent[]) {
    for (const event of events) {
      const row=this.statement("SELECT payload FROM thinking_events WHERE cursor=?").get(event.id) as EventRow | undefined;
      if (!row || row.payload!==canonicalJSON(event)) throw Error("EVENT_CURSOR_CONFLICT");
    }
  }
  updateMessages(messages:readonly ThinkingMessage[]) {this.project([],messages);}
  project(events:readonly ThinkingEvent[], messages?:readonly ThinkingMessage[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.appendWithin(events);
      if (messages) this.messagesWithin(messages);
      this.db.exec("COMMIT");
    } catch (error) {this.db.exec("ROLLBACK");throw error;}
  }
  private appendWithin(events:readonly ThinkingEvent[]) {
    let cursor = this.cursor();
    let segment = this.statement("SELECT segment_id,event_count,bytes FROM thinking_event_segments ORDER BY segment_id DESC LIMIT 1").get() as Segment | undefined;
    for (const event of events) {
      if (!Number.isSafeInteger(event.id) || event.id < 1) throw Error("INVALID_CURSOR");
      const payload = canonicalJSON(event), bytes = Buffer.byteLength(payload);
      if (bytes > eventByteLimit) throw Error("EVENT_STORAGE_LIMIT");
      if (event.id <= cursor) {
        const previous = this.statement("SELECT payload FROM thinking_events WHERE cursor=?").get(event.id) as EventRow | undefined;
        if (!previous || previous.payload !== payload) throw Error("EVENT_CURSOR_CONFLICT");
        continue;
      }
      if (event.id !== cursor + 1) throw Error("EVENT_CURSOR_GAP");
      if (!segment || segment.event_count >= eventSegmentCount || segment.bytes + bytes > eventByteLimit) {
        segment = {segment_id:(segment?.segment_id ?? 0)+1,event_count:0,bytes:0};
        this.statement("INSERT INTO thinking_event_segments VALUES(?,?,?,?,?)").run(segment.segment_id,event.id,event.id,0,0);
      }
      this.statement("INSERT INTO thinking_events VALUES(?,?,?,?,?)").run(event.id,this.sessionId,event.type,payload,segment.segment_id);
      segment.event_count++;segment.bytes+=bytes;cursor=event.id;
      this.statement("UPDATE thinking_event_segments SET last_cursor=?,event_count=?,bytes=? WHERE segment_id=?").run(cursor,segment.event_count,segment.bytes,segment.segment_id);
    }
    this.statement("UPDATE thinking_event_metadata SET cursor=? WHERE singleton=1").run(cursor);
  }
  private messagesWithin(messages:readonly ThinkingMessage[]) {
    // Message positions are stable for a session. Only its current answer changes
    // repeatedly; unchanged historical rows do not generate SQLite writes.
    for (const [ordinal,message] of messages.entries()) {
      this.statement(`INSERT INTO thinking_messages(message_id,ordinal,payload) VALUES(?,?,?)
        ON CONFLICT(message_id) DO UPDATE SET ordinal=excluded.ordinal,payload=excluded.payload
        WHERE thinking_messages.ordinal<>excluded.ordinal OR thinking_messages.payload<>excluded.payload`).run(message.id,ordinal,canonicalJSON(message));
    }
    this.statement("DELETE FROM thinking_messages WHERE ordinal>=?").run(messages.length);
  }
  read(after=0, limit=200, through=Number.MAX_SAFE_INTEGER):ThinkingEvent[] {
    bounded(limit,eventPageLimit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < after) throw Error("INVALID_CURSOR");
    const rows=this.statement("SELECT payload FROM thinking_events WHERE cursor>? AND cursor<=? ORDER BY cursor LIMIT ?").all(after,through,limit) as EventRow[];
    return rows.map(row=>JSON.parse(row.payload) as ThinkingEvent);
  }
  recent(limit=100):ThinkingEvent[] {
    bounded(limit,eventPageLimit);
    const rows=this.statement("SELECT payload FROM thinking_events ORDER BY cursor DESC LIMIT ?").all(limit) as EventRow[];
    return rows.reverse().map(row=>JSON.parse(row.payload) as ThinkingEvent);
  }
  messageCount() {
    return (this.statement("SELECT count(*) AS count FROM thinking_messages").get() as {count:number}).count;
  }
  messagePage(before?:string, limit=80) {
    bounded(limit,messageReadLimit);
    const totalMessages=this.messageCount();
    let end=totalMessages;
    if (before !== undefined) {
      const row=this.statement("SELECT ordinal FROM thinking_messages WHERE message_id=?").get(before) as {ordinal:number} | undefined;
      if (!row) throw Error("INVALID_HISTORY_CURSOR");
      end=row.ordinal;
    }
    const rows=this.statement("SELECT payload FROM thinking_messages WHERE ordinal<? ORDER BY ordinal DESC LIMIT ?").all(end,limit) as EventRow[];
    const items=rows.reverse().map(row=>JSON.parse(row.payload) as ThinkingMessage);
    const hasMore=end>items.length;
    return {items,...(hasMore?{nextBefore:items[0]!.id}:{}),hasMore,totalMessages};
  }
  recentMessages(limit=40) {return this.messagePage(undefined,limit).items;}
  fullMessages(limit=messageReadLimit) {
    bounded(limit,messageReadLimit);
    if (this.messageCount()>limit) throw Error("SESSION_HISTORY_LIMIT");
    return this.messagePage(undefined,limit).items;
  }
  segments() {
    return this.statement("SELECT segment_id,first_cursor,last_cursor,event_count,bytes FROM thinking_event_segments ORDER BY segment_id").all() as {segment_id:number;first_cursor:number;last_cursor:number;event_count:number;bytes:number}[];
  }
  close() {
    if(this.closed)return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();this.closed=true;this.statements.clear();
  }
}
