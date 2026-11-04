import type { ThinkingEvent } from "@writer-agent/contracts";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineTask, Harness, type ConversationId, type Harness as DurableHarness, type Registry, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export const durableContext = BACKGROUND_CONTEXT;
export const ThinkingState = defineDoc<{ saved: JsonValue; layout?:2; publishedCursor?:number; outbox?:ThinkingEvent[] }>({
  kind: "writer.thinking",
  version: 1,
  scope: "session",
  initial: () => ({ saved: null, layout:2, publishedCursor:0, outbox:[] }),
  // A layout change must retire the old session-scoped base immediately, so
  // reopening does not replay the former monolithic event history.
  checkpointWhen: (_value, ops, info) => info.deltasSinceBase >= 64 ||
    ops.some(op => op[0] === "s" && op[1].length === 1 && op[1][0] === "layout"),
});

export type DurableRuntime = {
  harness: DurableHarness;
  registry: Registry;
  setModels(models: Models): void;
  setRun(handler: (context: Context, signal: AbortSignal) => Promise<void>): void;
  createRun(tx: Tx, conversationId: ConversationId, runId: string): Promise<TaskId<null>>;
};

export async function openDurable(path: string): Promise<DurableRuntime> {
  let models: Models = createModels();
  let run: ((context: Context, signal: AbortSignal) => Promise<void>) | undefined;
  const registry = createRegistry();
  const task = defineTask<{ runId: string }, { phase: "run" }, null>({
    name: "writer.thinking",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        if (!run) throw Error("SESSION_INTERRUPTED");
        await run(context, runtime.signal);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  registry.install({ name: "writer.thinking.runtime", tasks: [task] });
  const storage = await openNodeSqliteStorage(path);
  try {
    const harness = await Harness.open(storage, {
      models: () => models,
      registry,
      identity: { attribution: null },
      settings: {
        stream: { maxRetries: 0 },
        retry: { enabled: false, maxRetries: 0 },
        compaction: { enabled: false, backgroundTokens: 0 },
        afterFailedRun: "withdraw",
      },
    }, durableContext);
    return {
      harness,
      registry,
      setModels(value) { models = value; },
      setRun(handler) { run = handler; },
      createRun: (tx, conversationId, runId) => tx.createTask(task, { runId }, {
        conversationId, ownership: { kind: "conversation" }, abandonOnRestart: true,
      }),
    };
  } catch (error) {
    await storage.close(durableContext);
    throw error;
  }
}

/** Old work must be marked before any operation that starts the scheduler. */
export async function interruptDurable(harness: DurableHarness): Promise<void> {
  const inspection = await harness.inspect(durableContext);
  for (const submission of inspection.submissions) {
    if (submission.status === "queued") await harness.abortSubmission(submission.id, durableContext);
  }
  for (const { record } of inspection.tasks) await harness.abortTask(record.id, durableContext);
  await Promise.all(inspection.tasks.map(({ record }) => harness.waitForTask(record.id, durableContext)));
}
