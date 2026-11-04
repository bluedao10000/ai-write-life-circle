import { reliabilityMetrics } from "../runtime/reliability.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  thinkingPrivateCreateSchema as createSchema,
  thinkingPrivateMessageSchema as messageSchema,
} from "@writer-agent/contracts";
import { PiHost, AgentError, safeCode } from "../runtime/pi-host.js";
import { modelEntries } from "../config.js";
import { idPattern } from "../sessions/store.js";
import { fullMessageLimit, historyPageLimit, recentMessageLimit } from "../sessions/projection.js";
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage) {
  let size = 0;
  const data = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new AgentError("REQUEST_TOO_LARGE", 413);
    data.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(data).toString()) as unknown;
  } catch {
    throw new AgentError("INVALID_JSON");
  }
}
export function server(host: PiHost) {
  return createServer(
    { maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 5000 },
    async (req, res) => {
      try {
        const provided = Buffer.from(req.headers.authorization ?? ""),
          expected = Buffer.from("Bearer " + host.config.token);
        if (
          provided.length !== expected.length ||
          !timingSafeEqual(provided, expected)
        )
          throw new AgentError("UNAUTHORIZED", 401);
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if(req.method==='GET'&&url.pathname==='/internal/v1/liveness'){
          json(res,200,{liveness:true});return;
        }
        if(req.method==='GET'&&url.pathname==='/internal/v1/readiness'){
          const health=host.health();json(res,health.readiness?200:503,health);return;
        }
        if(req.method==='GET'&&url.pathname==='/internal/v1/diagnostics'){
          json(res,200,host.diagnostics());return;
        }
        await host.ready;
        if (req.method === "GET" && url.pathname === "/internal/v1/health") {
          json(res, 200, {
            protocol: "thinking-v1",
            version: host.config.version,
            reliability: reliabilityMetrics(),
            runtime:host.health(),
            model: host.config.model,
            models: modelEntries(host.config).map(({model, enabled, description}) => ({model, enabled, description})),
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/internal/v1/sessions") {
          json(
            res,
            201,
            await host.create(createSchema.parse(await body(req))),
          );
          return;
        }
        const match =
          /^\/internal\/v1\/sessions\/(th-[a-f0-9-]{36})(?:\/(messages|events|history|cancel))?$/.exec(
            url.pathname,
          );
        if (!match || !idPattern.test(match[1]!))
          throw new AgentError("NOT_FOUND", 404);
        const id = match[1]!,
          action = match[2];
        if (req.method === "DELETE" && !action) {
          await host.delete(id);
          json(res, 200, {});
          return;
        }
        if (req.method === "POST" && action === "messages") {
          const b = messageSchema.parse(await body(req));
          json(res, 202, await host.accept(id, b.input, b.key, b.capability));
          return;
        }
        if (req.method === "POST" && action === "cancel") {
          const b=z.object({capability:z.string().max(4096).optional()}).strict().parse(await body(req));
          json(res, 200, await host.cancel(id,b.capability));
          return;
        }
        await host.store.waitPublished(id);
        const snapshot = host.store.snapshot(id, url.searchParams.get("full") === "1" && !action ? fullMessageLimit : recentMessageLimit);
        if (!snapshot || snapshot.status === "deleted") throw new AgentError("NOT_FOUND",404);
        if (req.method === "GET" && !action) {
          json(res, 200, snapshot);
          return;
        }
        if(req.method === "GET" && action === "history") {
          const before=url.searchParams.get("before") ?? undefined;
          if(before && before.length>128)throw new AgentError("INVALID_HISTORY_CURSOR",422);
          const page = host.store.history(id,before,historyPageLimit);
          if (!page) throw new AgentError("NOT_FOUND",404);
          json(res,200,page);
          return;
        }
        if (req.method === "GET" && action === "events") {
          let after = Number(url.searchParams.get("after") ?? 0);
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            after > snapshot.cursor
          )
            throw new AgentError("INVALID_CURSOR");
          if (req.headers.accept === "text/event-stream") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              Connection: "keep-alive",
            });
            res.flushHeaders();
            let ticking = false;
            const tick = async () => {
              if(ticking)return;
              ticking=true;
              try {
                await host.store.waitPublished(id);
                const current = host.store.readEvents(id,after,200);
                if (!current || current.deleted) {
                  res.end();
                  return;
                }
                for (const e of current.events.filter((e) => e.id > after)) {
                  res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
                  after = e.id;
                }
                if (current.view.status !== "running" && after >= current.view.cursor) res.end();
                else res.write(": heartbeat\n\n");
              } catch { res.end(); } finally {ticking=false;}
            };
            const timer = setInterval(tick, 500);
            res.on("close", () => clearInterval(timer));
            tick();
            return;
          }
          const items = host.store.readEvents(id,after,200)?.events ?? [];
          json(res, 200, {
            items,
            cursor: items.at(-1)?.id ?? after,
            status: snapshot.status,
          });
          return;
        }
        throw new AgentError("NOT_FOUND", 404);
      } catch (error) {
        const e = error instanceof Error && error.message === "INVALID_HISTORY_CURSOR"
          ? new AgentError("INVALID_HISTORY_CURSOR",422)
          : error instanceof Error && error.message === "SESSION_HISTORY_LIMIT"
            ? new AgentError("SESSION_HISTORY_LIMIT",413)
            : error;
        if (!res.headersSent)
          json(
            res,
            e instanceof AgentError
              ? e.status
              : e instanceof z.ZodError
                ? 422
                : 500,
            {
              code: e instanceof z.ZodError ? "VALIDATION_FAILED" : safeCode(e),
            },
          );
        else res.end();
      }
    },
  );
}
