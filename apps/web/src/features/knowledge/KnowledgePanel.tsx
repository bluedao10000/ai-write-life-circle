import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  MemoryAssertion,
  MemoryCorrection,
  MemoryEntity,
  MemoryMutation,
  MemoryPage,
  MemorySource,
  MemoryView,
} from "@writer-agent/contracts";
import type { KnowledgeSection as BookSection } from "../../components/vnext/BookView";
import {
  ConsentFacts,
  ConsentList,
  ConsentTitle,
} from "../../components/vnext/ConsentFacts";
import {
  Btn,
  Dot,
  Heading,
  Icon,
  Row,
  Seg,
  TextInput,
  ago,
} from "../../components/vnext/ui";
import { knowledgeApi } from "../../services/api/knowledgeApi";
import type { WriterAgentAdapter } from "../../services/writerAgent";
import KnowledgeDetail, {
  entityType,
  type DetailCorrection,
} from "./KnowledgeDetail";
import {
  Disclosure,
  EmptyState,
  ErrorState,
  ListSkeleton,
  More,
  NatureTag,
  SourceCard,
  useDebounced,
} from "./kit";
import {
  backfillProgress,
  knowledgeStatusText,
} from "./KnowledgeStatus";

type Props = {
  bookId: string;
  bookTitle?: string;
  chapterId: string;
  section: BookSection;
  adapter: WriterAgentAdapter;
  chapters?: { id: string; title: string }[];
  onChapter: (id: string) => void;
  onSection?: (section: BookSection) => void;
};

type Records = {
  jobs: Awaited<ReturnType<typeof knowledgeApi.jobs>> | null;
  history: Awaited<ReturnType<typeof knowledgeApi.history>> | null;
  corrections: Awaited<ReturnType<typeof knowledgeApi.corrections>> | null;
};

type CacheEntry = { page: MemoryPage; records?: Records; loadedAt: number };
type HistoryRow = {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
  technical: string;
  correction?: MemoryCorrection;
};

const meta: Record<
  BookSection,
  {
    type?: string;
    search?: string;
    label: string;
    description: string;
    other: BookSection;
  }
> = {
  chapter: {
    label: "本章相关",
    description:
      "写这一章时值得记住的人物、事件、设定与伏笔，每条都附有原文依据。",
    other: "notes",
  },
  people: {
    type: "character",
    search: "按名字、别名或身份查找",
    label: "人物",
    description:
      "从正文整理出的人物档案，区分正文写明的、角色自己说的和 AI 的推测。",
    other: "chapter",
  },
  world: {
    type: "place,organization,world_rule",
    search: "查找地点、组织或规则",
    label: "世界与规则",
    description: "地点、组织与世界规则。没有原文依据的条目会明确标出。",
    other: "chapter",
  },
  timeline: {
    type: "event",
    search: "查找事件、人物或地点",
    label: "时间线",
    description: "按章节顺序排列的事件。时间不明确的地方，不会替你补上日期。",
    other: "chapter",
  },
  plot: {
    type: "plot_line",
    search: "查找剧情线或线索",
    label: "剧情结构",
    description: "剧情线与线索，以及支撑它们的章节和原文证据。",
    other: "chapter",
  },
  threads: {
    type: "foreshadowing",
    search: "查找伏笔",
    label: "伏笔",
    description:
      "AI 发现的候选伏笔和后续相关原文。是否回收、何时回收，由你判断。",
    other: "chapter",
  },
  notes: {
    search: "查找笔记",
    label: "创作笔记",
    description: "你的想法与下一章计划。笔记不会自动成为作品设定。",
    other: "chapter",
  },
  history: {
    search: "查找记录",
    label: "变更历史",
    description:
      "知识整理、引用失效、你的纠正和任务失败，都按时间记在这里。",
    other: "chapter",
  },
};

const BACKGROUND_PROBE_DELAYS = [1_500, 4_000, 8_000] as const;

export function KnowledgePanel(props: Props) {
  const {
    bookId,
    bookTitle,
    chapterId,
    section,
    adapter,
    chapters = [],
    onChapter,
    onSection,
  } = props;
  const [view, setView] = useState<MemoryView | null>(null);
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [records, setRecords] = useState<Records>({
    jobs: null,
    history: null,
    corrections: null,
  });
  const [phase, setPhase] = useState<"loading" | "ready" | "refreshing" | "error">(
    "loading",
  );
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query.trim(), 250);
  const [entityCursor, setEntityCursor] = useState(0);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState<{
    value: MemorySource;
    markdown?: string;
    message: string;
  } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [consent, setConsent] = useState(false);
  const [budget, setBudget] = useState("100000000");
  const [jobBudget, setJobBudget] = useState("200");
  const [timelineKnown, setTimelineKnown] = useState<"all" | "known">("all");
  const [historyKind, setHistoryKind] = useState("all");
  const [notice, setNotice] = useState("");
  const [queuedAfterEnable, setQueuedAfterEnable] = useState(false);
  const [detailFacts, setDetailFacts] = useState<MemoryAssertion[]>([]);
  const [detailFactPhase, setDetailFactPhase] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [detailRetry, setDetailRetry] = useState(0);
  const summaryEpoch = useRef(0);
  const dataEpoch = useRef(0);
  const recordEpoch = useRef(0);
  const sourceEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const selectedIdRef = useRef(selectedId);
  const cache = useRef(new Map<string, CacheEntry>());

  const requestKey = useMemo(
    () =>
      [
        bookId,
        chapterId,
        section,
        entityCursor,
        historyCursor,
        debouncedQuery,
      ].join("\0"),
    [
      bookId,
      chapterId,
      debouncedQuery,
      entityCursor,
      historyCursor,
      section,
    ],
  );

  useEffect(() => {
    ++dataEpoch.current;
    setEntityCursor(0);
    setHistoryCursor(0);
    setQuery("");
    setSelectedId(null);
    setDetailFacts([]);
    setDetailFactPhase("idle");
    setSource(null);
    setError("");
    setSummaryError("");
  }, [chapterId, section]);

  useEffect(() => {
    if (!queuedAfterEnable) return;
    setRefresh((value) => value + 1);
  }, [queuedAfterEnable]);

  useEffect(() => {
    const generation = ++summaryEpoch.current;
    const abort = new AbortController();
    void knowledgeApi
      .summary(bookId, abort.signal)
      .then((next) => {
        if (generation !== summaryEpoch.current || abort.signal.aborted) return;
        setView(next);
        setSummaryError("");
      })
      .catch(() => {
        if (generation === summaryEpoch.current && !abort.signal.aborted)
          setSummaryError(
            "知识维护状态暂时无法读取；已有知识仍可继续阅读。",
          );
      });
    return () => abort.abort();
  }, [bookId, refresh]);

  useEffect(() => {
    cache.current.clear();
    ++dataEpoch.current;
    ++summaryEpoch.current;
    setView(null);
    setPage(null);
    setRecords(emptyRecords());
    setSelectedId(null);
    setSource(null);
    setDetailFacts([]);
    setDetailFactPhase("idle");
  }, [bookId]);

  useEffect(() => {
    if (refresh === 0) return;
    cache.current.clear();
    recordEpoch.current += 1;
    setRecords(emptyRecords());
  }, [refresh]);

  useEffect(() => {
    if (!queuedAfterEnable) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await knowledgeApi.summary(bookId);
        if (cancelled) return;
        setView(next);
        if (
          next.pending > 0 ||
          next.running > 0 ||
          (next.completed ?? 0) > 0
        ) {
          setQueuedAfterEnable(false);
          setRefresh((value) => value + 1);
          return;
        }
      } catch {
        if (cancelled) return;
        setSummaryError(
          "知识维护已启用，正在等待后台开始整理；稍后会自动重试。",
        );
      }
      timer = setTimeout(() => void poll(), 3_000);
    };
    timer = setTimeout(() => void poll(), 1_500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bookId, queuedAfterEnable]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const generation = ++dataEpoch.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probeTimers: ReturnType<typeof setTimeout>[] = [];
    let shouldPoll = false;
    const saved = cache.current.get(requestKey);
    if (saved) {
      setPage(saved.page);
      setRecords(saved.records ?? emptyRecords());
      setPhase("refreshing");
      setError("");
    } else {
      setPage(null);
      setPhase("loading");
    }

    const load = async () => {
      try {
        if (section === "history" || section === "notes") {
          const [summary, jobs, changes, corrections] = await Promise.all([
            knowledgeApi.summary(bookId, abort.signal),
            knowledgeApi.jobs(bookId, abort.signal),
            knowledgeApi.history(bookId, abort.signal, historyCursor),
            knowledgeApi.corrections(bookId, abort.signal),
          ]);
          if (generation !== dataEpoch.current || abort.signal.aborted) return;
          const next = emptyPage(summary, bookId);
          const nextRecords = { jobs, history: changes, corrections };
          setView(summary);
          setPage(next);
          setRecords(nextRecords);
          cache.current.set(requestKey, {
            page: next,
            records: nextRecords,
            loadedAt: Date.now(),
          });
        } else {
          const params = new URLSearchParams({
            cursor: String(entityCursor),
            // A category request includes a bounded first fact slice for the
            // list summaries. Opening an entity makes a separate bounded query.
            assertionCursor: "0",
            limit: "20",
          });
          if (meta[section].type) params.set("type", meta[section].type!);
          if (section === "chapter") params.set("chapterId", chapterId);
          if (debouncedQuery) params.set("name", debouncedQuery);
          const next = await knowledgeApi.query(bookId, params, abort.signal);
          if (generation !== dataEpoch.current || abort.signal.aborted) return;
          setPage(next);
          setView(next);
          shouldPoll = next.running > 0 || next.pending > 0;
          cache.current.set(requestKey, {
            page: next,
            records: saved?.records,
            loadedAt: Date.now(),
          });
        }
        setPhase("ready");
        setError("");
      } catch (cause) {
        if (generation !== dataEpoch.current || abort.signal.aborted) return;
        setError(friendlyKnowledgeError(cause));
        setPhase(saved ? "refreshing" : "error");
      } finally {
        const currentRequest =
          generation === dataEpoch.current &&
          !abort.signal.aborted &&
          section !== "history";
        if (!currentRequest) {
          // A newer context owns this panel; do not schedule stale refreshes.
        } else if (shouldPoll) {
          timer = setTimeout(() => {
            setNotice("正在读取后台新整理的知识…");
            setRefresh((value) => value + 1);
          }, 15_000);
        } else {
          // The Worker creates a job on its next poll, so an immediate successful
          // read can legitimately say "no pending work". Probe a few times only
          // when this request belongs to the current view, then settle to the
          // normal schedule or stop until the author changes context.
          const probeGeneration = dataEpoch.current;
          let elapsed = 0;
          BACKGROUND_PROBE_DELAYS.forEach((delay) => {
            elapsed += delay;
            probeTimers.push(
              setTimeout(() => {
                if (
                  dataEpoch.current !== probeGeneration ||
                  abort.signal.aborted
                )
                  return;
                void knowledgeApi
                  .summary(bookId, abort.signal)
                  .then((next) => {
                    if (
                      dataEpoch.current !== probeGeneration ||
                      abort.signal.aborted
                    )
                      return;
                    setView(next);
                    if (next.pending > 0 || next.running > 0) {
                      setRefresh((value) => value + 1);
                    }
                  })
                  .catch(() => {
                    // Freshness probing is best effort. A later one-shot or manual
                    // refresh remains available and must not replace readable data
                    // with an error screen.
                  });
              }, elapsed),
            );
          });
        }
      }
    };
    void load();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
      probeTimers.forEach(clearTimeout);
    };
  }, [
    bookId,
    chapterId,
    debouncedQuery,
    entityCursor,
    historyCursor,
    refresh,
    requestKey,
    section,
  ]);

  useEffect(() => {
    if (!selectedId || records.corrections) return;
    const generation = ++recordEpoch.current;
    const abort = new AbortController();
    void knowledgeApi
      .corrections(bookId, abort.signal)
      .then((corrections) => {
        if (generation !== recordEpoch.current || abort.signal.aborted) return;
        setRecords((current) => ({ ...current, corrections }));
      })
      .catch(() => {
        if (generation === recordEpoch.current && !abort.signal.aborted)
          setNotice("你的纠正记录暂时无法读取；知识内容仍可查看。");
      });
    return () => abort.abort();
  }, [bookId, records.corrections, selectedId]);

  useEffect(() => {
    const generation = ++detailEpoch.current;
    setDetailFacts([]);
    if (!selectedId || meta[section].type === undefined) {
      setDetailFactPhase("idle");
      return;
    }
    const requestedId = selectedId;
    const abort = new AbortController();
    setDetailFactPhase("loading");
    const params = new URLSearchParams({ cursor: "0", assertionCursor: "0", limit: "1" });
    void knowledgeApi
      .query(
        bookId,
        params,
        abort.signal,
        `/entities/${encodeURIComponent(selectedId)}`,
      )
      .then((next) => {
        if (
          generation !== detailEpoch.current ||
          selectedIdRef.current !== requestedId ||
          abort.signal.aborted
        )
          return;
        setDetailFacts(
          next.assertions.filter(
            (assertion) => assertion.entityId === requestedId,
          ),
        );
        setDetailFactPhase("ready");
      })
      .catch(() => {
        if (
          generation === detailEpoch.current &&
          selectedIdRef.current === requestedId &&
          !abort.signal.aborted
        ) {
          setDetailFactPhase("error");
        }
      });
    return () => abort.abort();
  }, [bookId, detailRetry, section, selectedId]);

  const current = page ?? (view ? emptyPage(view, bookId) : null);
  const currentChapter = chapters.find((chapter) => chapter.id === chapterId);
  const selected = current?.entities.find(
    (entity) => entity.entityId === selectedId,
  );
  const pageAssertions = current?.assertions ?? [];
  const assertions =
    detailFactPhase === "ready" && detailFacts.length > 0
      ? detailFacts
      : pageAssertions;
  const entities = current?.entities ?? [];

  const mutate = async (
    action: string,
    values: Partial<MemoryMutation> = {},
  ) => {
    if (!page) return false;
    const generation = ++mutationEpoch.current;
    setBusy(true);
    setError("");
    try {
      const next = await knowledgeApi.mutate(bookId, action, {
        baseVersion: page.version,
        ...values,
      });
      if (generation !== mutationEpoch.current) return true;
      setView(next);
      setShowSettings(false);
      setNotice("操作已保存。");
      if (action === "enable") {
        setQueuedAfterEnable(true);
        setNotice("已启用；正在等待后台为已保存正文建立整理任务。");
      }
      setRefresh((value) => value + 1);
      return true;
    } catch (cause) {
      if (generation === mutationEpoch.current) {
        setError(friendlyKnowledgeError(cause, "操作失败，请刷新后重试。"));
        setNotice("");
      }
      return false;
    } finally {
      if (generation === mutationEpoch.current) setBusy(false);
    }
  };

  const readSource = async (value: MemorySource) => {
    const generation = ++sourceEpoch.current;
    setSource({
      value,
      message:
        value.validity === "current"
          ? "正在读取保存版本…"
          : value.validity === "stale"
            ? "这是旧版本证据，当前正文可能已经改变。"
            : "来源正文暂不可用，仍可查看已保存的引文。",
    });
    if (value.validity !== "current" || adapter.mode !== "api") return;
    try {
      const detail = await adapter.loadChapter(bookId, value.chapterId);
      if (generation !== sourceEpoch.current) return;
      const revision = detail.headRevision;
      if (
        revision.revisionId !== value.revisionId ||
        revision.contentHash !== value.contentHash ||
        revision.markdown.slice(value.startUTF16, value.endUTF16) !== value.quote
      ) {
        setSource({
          value,
          message: "正文版本已经变化。保留旧引文，不在新正文中强行定位。",
        });
        return;
      }
      setSource({
        value,
        markdown: revision.markdown,
        message: "已定位保存版本中的原文；原文真实不代表 AI 推断成立。",
      });
    } catch {
      if (generation === sourceEpoch.current)
        setSource({
          value,
          message: "来源正文暂不可用，仍可查看已保存的引文。",
        });
    }
  };

  const submitCorrection = async (correction: DetailCorrection) => {
    const assertion = assertions.find(
      (value) => value.assertionId === correction.assertionId,
    );
    const saved = await mutate("correct", {
      action: correction.action,
      assertionId: correction.assertionId,
      entityId: correction.entityId,
      chapterId:
        correction.chapterId ||
        assertion?.sources[0]?.chapterId ||
        chapterId,
      reason: correction.reason,
    });
    if (saved) setNotice("你的纠正已保存，可以随时撤销。");
  };

  const body = () => {
    if (!current) return <ListSkeleton rows={section === "timeline" ? 5 : 4} />;
    if (section === "notes") return null;
    if (section === "history")
      return (
        <HistorySection
          records={records}
          query={debouncedQuery}
          kind={historyKind}
          setKind={setHistoryKind}
          busy={busy}
          onUndo={(id) => void mutate("undo", { correctionId: id })}
          onNext={() => {
            if (records.history?.nextCursor != null)
              setHistoryCursor(records.history.nextCursor);
          }}
          onFirst={() => setHistoryCursor(0)}
        />
      );
    if (!entities.length) return EmptyKnowledgeState(current, section, debouncedQuery, setQuery, () => {
      setBudget(String(current.settings.dailyTokenBudget));
      setJobBudget(String(current.settings.dailyJobBudget));
      setShowSettings(true);
    });
    if (section === "chapter")
      return (
        <ChapterSection
          entities={entities}
          assertions={assertions}
          chapters={chapters}
          selectedId={selectedId}
          onOpen={setSelectedId}
          onRead={readSource}
          onChapter={onChapter}
        />
      );
    if (section === "timeline")
      return (
        <TimelineSection
          entities={entities}
          assertions={assertions}
          chapters={chapters}
          known={timelineKnown}
          setKnown={setTimelineKnown}
          selectedId={selectedId}
          onOpen={setSelectedId}
          onRead={readSource}
          onChapter={onChapter}
        />
      );
    return (
      <EntitySection
        section={section}
        entities={entities}
        assertions={assertions}
        chapters={chapters}
        selectedId={selectedId}
        onOpen={setSelectedId}
      />
    );
  };

  return (
    <section
      aria-label="自动作品知识"
      className="relative flex h-full min-h-0"
    >
      <div className="scroll min-w-0 flex-1 overflow-auto">
        <header className="border-b border-line-soft px-5 pt-5 pb-4 md:px-8 md:pt-7">
          <div className="mx-auto max-w-page">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-ui-sm text-ink-3">
                {bookTitle || "当前作品"} <span className="text-ink-4">/</span> 书
              </span>
              <div className="relative ml-auto flex items-center gap-2">
                {summaryError ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-dashed border-line px-2.5 py-0.5 text-ui-sm text-ink-3">
                    <Dot tone="warn" />
                    维护状态暂不可用
                    <Btn
                      variant="link"
                      className="text-ui-sm"
                      onClick={() => setRefresh((value) => value + 1)}
                    >
                      重试
                    </Btn>
                  </span>
                ) : view ? (
                  <MaintenancePill
                    view={view}
                    onOpen={() => {
                      setBudget(String(view.settings.dailyTokenBudget));
                      setJobBudget(String(view.settings.dailyJobBudget));
                      setShowSettings(true);
                    }}
                  />
                ) : (
                  <span className="text-ui-sm text-ink-3">
                    正在读取维护状态…
                  </span>
                )}
              </div>
            </div>
            <label className="mt-3 block md:hidden">
              <span className="sr-only">知识分类</span>
              <select
                aria-label="知识分类"
                value={section}
                onChange={(event) =>
                  onSection?.(event.target.value as BookSection)
                }
                className="w-full rounded-md border border-line bg-surface px-3 py-2 text-ui text-ink"
              >
                {(Object.keys(meta) as BookSection[]).map((id) => (
                  <option key={id} value={id}>
                    {meta[id].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Heading level={1}>
                {section === "chapter" && currentChapter
                  ? `${chapterNo(currentChapter)}${
                      currentChapter.title
                        ? ` · ${currentChapter.title.replace(/^第\s*\d+\s*章\s*/, "")}`
                        : ""
                    }`
                  : meta[section].label}
              </Heading>
              {phase === "refreshing" && (
                <span
                  className="inline-flex items-center gap-1.5 text-ui-sm text-ink-3"
                  title="先显示上次读取的内容，更新完成后自动替换"
                >
                  <Icon name="refresh" className="h-3 w-3 spin" />
                  正在更新
                </span>
              )}
            </div>
            <p className="mt-1 text-ui text-ink-3">
              {section === "chapter" ? "本章相关 · " : ""}
              {meta[section].description}
            </p>
          </div>
        </header>
        <div className="mx-auto max-w-page px-5 pt-6 pb-24 md:px-8">
          {meta[section].search && (
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <TextInput
                label={meta[section].search!}
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setEntityCursor(0);
                }}
                placeholder={meta[section].search}
                className="w-full sm:max-w-xs"
              />
              <span className="text-ui-sm text-ink-3" aria-live="polite">
                {query.trim() !== debouncedQuery
                  ? "筛选中…"
                  : debouncedQuery
                    ? `已筛选“${debouncedQuery}”`
                    : ""}
              </span>
            </div>
          )}
          <div>
            {phase === "loading" ? (
              <ListSkeleton rows={section === "timeline" ? 5 : 4} />
            ) : phase === "error" ? (
              <ErrorState
                onRetry={() => setRefresh((value) => value + 1)}
                onOther={() => {
                  onSection?.(meta[section].other);
                }}
                otherLabel={
                  section === "chapter" ? "先看创作笔记" : "先看本章相关"
                }
              />
            ) : (
              <>
                {phase === "refreshing" && (
                  <p className="mb-5 flex flex-wrap items-center gap-x-2 rounded-md bg-surface-2 px-3 py-2 text-ui-sm text-ink-2">
                    <Icon name="refresh" className="h-3 w-3 spin" />
                    {error
                      ? "更新没有完成，下面是之前读取的内容，可能不是最新的。"
                      : "正在更新知识，下面是之前读取的内容。"}
                    {error && (
                      <Btn
                        variant="link"
                        className="text-ui-sm"
                        onClick={() => setRefresh((value) => value + 1)}
                      >
                        重试
                      </Btn>
                    )}
                  </p>
                )}
                {!current?.settings.enabled && current && entities.length > 0 && (
                  <p className="mb-5 rounded-md bg-surface-2 px-3 py-2 text-ui-sm text-ink-2">
                    知识维护已关闭。下面是之前整理的内容，不会随正文更新。
                  </p>
                )}
                {body()}
                {current &&
                  current.entities.length > 0 &&
                  (current.nextCursor !== null ||
                    entityCursor > 0) && (
                    <div className="mt-6 flex flex-wrap gap-2">
                      {entityCursor > 0 && (
                        <Btn
                          onClick={() =>
                            setEntityCursor(Math.max(0, entityCursor - 20))
                          }
                        >
                          上一页
                        </Btn>
                      )}
                      {current.nextCursor !== null && (
                        <Btn
                          onClick={() =>
                            setEntityCursor(current.nextCursor!)
                          }
                        >
                          下一页
                        </Btn>
                      )}
                    </div>
                  )}
              </>
            )}
          </div>
          {notice && (
            <p role="status" className="mt-4 text-ui-sm text-ok">
              {notice}
            </p>
          )}
          {showSettings && current && (
            <SettingsPanel
              page={current}
              busy={busy}
              consent={consent}
              setConsent={setConsent}
              budget={budget}
              setBudget={setBudget}
              jobBudget={jobBudget}
              setJobBudget={setJobBudget}
              onClose={() => setShowSettings(false)}
              onEnable={() =>
                void mutate("enable", {
                  consent: true,
                  model: current.model,
                  dailyTokenBudget: Number(budget),
                  dailyJobBudget: Number(jobBudget),
                })
              }
              onPause={() =>
                void mutate(current.settings.paused ? "resume" : "pause")
              }
              onRebuild={() => void mutate("rebuild", { chapterId })}
            />
          )}
        </div>
      </div>

      {selected && (
        <>
          <div
            className="fade fixed inset-0 z-40 bg-scrim xl:hidden"
            onClick={() => setSelectedId(null)}
            aria-hidden
          />
          <aside
            aria-label="知识详情"
            className="slide-r fixed inset-y-0 right-0 z-50 w-full border-l border-line-soft shadow-soft sm:max-w-[22.5rem] xl:static xl:z-auto xl:w-[22.5rem] xl:shrink-0 xl:shadow-none"
          >
            <KnowledgeDetail
              entity={selected}
              assertions={assertions}
              entities={entities}
              corrections={records.corrections?.items ?? []}
              chapters={chapters}
              busy={busy}
              loadingFacts={detailFactPhase === "loading"}
              factsError={detailFactPhase === "error"}
              onRetryFacts={() => setDetailRetry((value) => value + 1)}
              onClose={() => setSelectedId(null)}
              onEntity={setSelectedId}
              onReadSource={(value) => void readSource(value)}
              onChapter={onChapter}
              onCorrect={(value) => void submitCorrection(value)}
              onUndo={(id) => void mutate("undo", { correctionId: id })}
            />
          </aside>
        </>
      )}

      {source && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-scrim p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="原文证据"
          onClick={() => setSource(null)}
        >
          <div
            className="fade-up max-h-full w-full overflow-auto rounded-t-xl border border-line bg-surface p-6 shadow-soft sm:max-w-2xl sm:rounded-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <Heading level={2} className="text-ui-lg text-ink">
              {chapterName(source.value.chapterId, chapters)} · 保存版本原文
            </Heading>
            <p className="my-2 text-ui-sm text-ink-3">{source.message}</p>
            {source.value.validity === "stale" && (
              <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-ui-sm text-ink-2">
                原文已修改。以下仍是当时保存的引文，不会被强行映射到当前正文。
              </p>
            )}
            <pre className="scroll my-4 max-h-80 overflow-auto whitespace-pre-wrap font-prose text-ui-lg text-ink">
              {source.markdown ? (
                <>
                  {source.markdown.slice(0, source.value.startUTF16)}
                  <mark>{source.value.quote}</mark>
                  {source.markdown.slice(source.value.endUTF16)}
                </>
              ) : (
                source.value.quote
              )}
            </pre>
            <div className="flex flex-wrap gap-3">
              <Btn
                onClick={() => {
                  const target = source.value.chapterId;
                  setSource(null);
                  setSelectedId(null);
                  onChapter(target);
                }}
              >
                打开章节
              </Btn>
              <Btn variant="quiet" onClick={() => setSource(null)}>
                收起依据
              </Btn>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function MaintenancePill({
  view,
  onOpen,
}: {
  view: MemoryView;
  onOpen: () => void;
}) {
  const progress = backfillProgress(view);
  const text = view.running
    ? progress
      ? `正在整理 ${progress.done}/${progress.total} 章`
      : "正在整理"
    : knowledgeStatusText(view);
  const tone =
    !view.settings.enabled
      ? "quiet"
      : view.settings.paused || view.workerStatus === "offline"
        ? "warn"
        : view.failed
          ? "danger"
          : view.running || view.pending
            ? "ai"
            : "ok";
  return (
    <Btn
      size="sm"
      variant="outline"
      className="rounded-full"
      onClick={onOpen}
      title="知识维护设置"
    >
      <Dot tone={tone} />
      {text}
    </Btn>
  );
}

function EmptyKnowledgeState(
  page: MemoryPage,
  section: BookSection,
  query: string,
  clear: (value: string) => void,
  openSettings: () => void,
) {
  if (query)
    return (
      <EmptyState
        icon="search"
        title={`没有找到与“${query}”相关的知识`}
        body="换一个关键词，或者清除筛选查看全部。"
      >
        <Btn variant="outline" onClick={() => clear("")}>
          清除筛选
        </Btn>
      </EmptyState>
    );
  if (!page.settings.enabled || page.needsModelConsent)
    return (
      <EmptyState
        icon="info"
        title="启用知识维护后开始整理"
        body="开启后，AI 会从已保存正文整理人物、事件与设定。正文不会被修改，结果也不会自动成为正式设定。"
      >
        <Btn
          variant="primary"
          disabled={!page.available}
          onClick={openSettings}
        >
          启用自动整理
        </Btn>
      </EmptyState>
    );
  if (page.pending > 0 || page.running > 0)
    return (
      <EmptyState
        icon="refresh"
        title={section === "chapter" ? "本章尚未整理出相关知识" : "正在整理知识"}
        body={`已整理 ${page.completed ?? 0} / ${page.chapterTotal ?? "?"} 章。相关知识会逐步出现在这里，你可以继续写作。`}
      />
    );
  return (
    <EmptyState
      icon={section === "chapter" ? "target" : "layers"}
      title={
        section === "chapter"
          ? "本章暂时没有关联的知识"
          : "还没有整理出这一类知识"
      }
      body="保存正文后，相关知识会逐步出现在这里。"
    />
  );
}

function SettingsPanel({
  page,
  busy,
  consent,
  setConsent,
  budget,
  setBudget,
  jobBudget,
  setJobBudget,
  onClose,
  onEnable,
  onPause,
  onRebuild,
}: {
  page: MemoryPage;
  busy: boolean;
  consent: boolean;
  setConsent: (value: boolean) => void;
  budget: string;
  setBudget: (value: string) => void;
  jobBudget: string;
  setJobBudget: (value: string) => void;
  onClose: () => void;
  onEnable: () => void;
  onPause: () => void;
  onRebuild: () => void;
}) {
  const currentModel =
    JSON.stringify(page.settings.model) === JSON.stringify(page.model) &&
    !page.needsModelConsent;
  return (
    <div
      className="fade-up mt-6 space-y-3 rounded-xl border border-line bg-surface p-5"
      aria-label="知识维护授权"
    >
      <h2 className="text-ui-lg font-medium text-ink">
        <ConsentTitle>让 AI 自动记住这部作品</ConsentTitle>
      </h2>
      <p className="text-ui-sm text-ink-2">{page.disclosure}</p>
      <ConsentFacts
        rows={[
          ["服务", page.model.provider],
          ["模型", page.model.model],
          ["端点", page.model.endpoint],
        ]}
      />
      <ConsentList
        title="不会做"
        kind="never"
        items={[
          "读取你的私人笔记",
          "修改正文、已确认的设定或发布内容",
          "让 AI 推测自动成为已确认设定",
        ]}
      />
      {page.settings.enabled && currentModel ? (
        <div className="flex flex-wrap gap-2">
          <Btn variant="outline" disabled={busy} onClick={onPause}>
            {page.settings.paused ? "恢复自动整理" : "暂停自动整理"}
          </Btn>
          <Btn variant="outline" disabled={busy} onClick={onRebuild}>
            重新分析本章
          </Btn>
          <Btn variant="quiet" onClick={onClose}>
            关闭
          </Btn>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-ui-sm text-ink-2">每日 Token 上限</p>
              <TextInput
                label="每日 Token 上限（保守预留）"
                value={budget}
                onChange={setBudget}
              />
            </div>
            <div>
              <p className="mb-1 text-ui-sm text-ink-2">每日执行次数</p>
              <TextInput
                label="每日执行次数上限（含失败与重试）"
                value={jobBudget}
                onChange={setJobBudget}
              />
            </div>
          </div>
          <p className="text-ui-sm text-ink-3">
            两项额度任一用完即暂停，次日北京时间 08:00 重置。失败与重试也计次。
          </p>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-2 px-3.5 py-2.5 text-ui-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5 accent-current"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我授权发送此作品已保存及后续保存的正文，并了解模型费用。
          </label>
          <div className="flex gap-3">
            <Btn
              variant="primary"
              disabled={!consent || busy || !page.available}
              onClick={onEnable}
            >
              确认启用
            </Btn>
            <Btn variant="quiet" onClick={onClose}>
              取消
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}

function ChapterSection({
  entities,
  assertions,
  chapters,
  selectedId,
  onOpen,
  onRead,
  onChapter,
}: {
  entities: MemoryEntity[];
  assertions: MemoryAssertion[];
  chapters: { id: string; title: string }[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onRead: (source: MemorySource) => void;
  onChapter: (id: string) => void;
}) {
  const groups = groupEntities(entities);
  const sources = uniqueSources(assertions);
  return (
    <>
      <p className="mb-6 font-prose text-read text-ink-2">
        本章关联 {entities.length} 条可追溯知识，按人物、事件、设定与剧情分组。
        每个条目都能回到保存的正文。
      </p>
      {groups.map(([title, list], index) => (
        <Group
          key={title}
          title={title}
          count={list.length}
          defaultOpen={index < 2}
        >
          {list.map((entity) => {
            const own = assertions.filter(
              (assertion) => assertion.entityId === entity.entityId,
            );
            return (
              <EntityCard
                key={entity.entityId}
                entity={entity}
                assertions={own}
                source={uniqueSources(own)[0]}
                active={selectedId === entity.entityId}
                onOpen={() => onOpen(entity.entityId)}
                onRead={onRead}
              />
            );
          })}
        </Group>
      ))}
      {sources.length > 0 && (
        <Group title="原文依据" count={sources.length} defaultOpen={false}>
          {sources.map((value) => (
            <SourceCard
              key={`${value.chapterId}-${value.revisionId}-${value.startUTF16}`}
              source={value}
              chapterLabel={chapterName(value.chapterId, chapters)}
              onRead={onRead}
              onChapter={(item) => onChapter(item.chapterId)}
            />
          ))}
        </Group>
      )}
    </>
  );
}

function EntitySection({
  section,
  entities,
  assertions,
  chapters,
  selectedId,
  onOpen,
}: {
  section: BookSection;
  entities: MemoryEntity[];
  assertions: MemoryAssertion[];
  chapters: { id: string; title: string }[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const [shown, setShown] = useState(12);
  const groups =
    section === "world"
      ? (["place", "organization", "world_rule"] as const).map(
          (type) =>
            [
              entityType[type],
              entities.filter((entity) => entity.type === type),
            ] as const,
        )
      : [["知识条目", entities] as const];
  return (
    <>
      {groups.map(
        ([title, values]) =>
          values.length > 0 && (
            <Group key={title} title={title} count={values.length}>
              {values.slice(0, shown).map((entity) => {
                const own = assertions.filter(
                  (assertion) => assertion.entityId === entity.entityId,
                );
                const sources = uniqueSources(own);
                const bad = sources.filter(
                  (source) => source.validity !== "current",
                ).length;
                const latest = own.find(
                  (assertion) =>
                    assertion.epistemic === "observation" &&
                    assertion.status === "current",
                );
                const recent = [
                  ...new Set(sources.map((source) => source.chapterId)),
                ].slice(-3);
                return (
                  <EntityCard
                    key={entity.entityId}
                    entity={entity}
                    assertions={own}
                    source={sources[0]}
                    latest={latest?.text}
                    active={selectedId === entity.entityId}
                    onOpen={() => onOpen(entity.entityId)}
                    onRead={() => undefined}
                    footer={
                      <div className="flex flex-wrap gap-x-3 text-micro text-ink-3">
                        <span
                          className={
                            bad
                              ? "inline-flex items-center gap-1 text-warn"
                              : "inline-flex items-center gap-1"
                          }
                        >
                          <Dot
                            tone={
                              bad ? "warn" : sources.length ? "ok" : "quiet"
                            }
                          />
                          {bad
                            ? `${bad} 条引用需核对`
                            : sources.length
                              ? "引用均为当前版本"
                              : "暂无原文引用"}
                        </span>
                        {recent.length > 0 && (
                          <span>
                            最近出现：
                            {recent
                              .map((id) => chapterName(id, chapters))
                              .join("、")}
                          </span>
                        )}
                        {own.length > 0 && <span>{own.length} 条知识</span>}
                      </div>
                    }
                  />
                );
              })}
            </Group>
          ),
      )}
      <More
        shown={shown}
        total={entities.length}
        onMore={() => setShown((value) => value + 12)}
      />
      {section === "threads" && (
        <p className="mt-4 text-ui-sm text-ink-3">
          这些只是候选伏笔。AI 不会替你判断是否已回收，也不会生成虚构的回收章节。
        </p>
      )}
      {section === "plot" && (
        <p className="mt-4 text-ui-sm text-ink-3">
          不显示剧情进度或完成度，因为当前数据无法可靠证明剧情已经走到哪一步。
        </p>
      )}
    </>
  );
}

function TimelineSection({
  entities,
  assertions,
  chapters,
  known,
  setKnown,
  selectedId,
  onOpen,
  onRead,
  onChapter,
}: {
  entities: MemoryEntity[];
  assertions: MemoryAssertion[];
  chapters: { id: string; title: string }[];
  known: "all" | "known";
  setKnown: (value: "all" | "known") => void;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onRead: (source: MemorySource) => void;
  onChapter: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = entities
    .map((entity) => {
      const own = assertions.filter(
        (assertion) => assertion.entityId === entity.entityId,
      );
      return {
        entity,
        own,
        time: own.find((assertion) => assertion.time)?.time,
        sources: uniqueSources(own),
      };
    })
    .filter((item) => known === "all" || !!item.time)
    .sort((a, b) =>
      (a.sources[0]?.chapterId ?? "").localeCompare(
        b.sources[0]?.chapterId ?? "",
        undefined,
        { numeric: true },
      ),
    );
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Seg
          size="sm"
          label="时间线筛选"
          value={known}
          onChange={setKnown}
          options={[
            ["all", "全部事件"],
            ["known", "只看时间明确的"],
          ]}
        />
        <span className="text-micro text-ink-3">
          按章节顺序排列；时间不明确时不会补造日期。
        </span>
      </div>
      <ol>
        {list.map(({ entity, own, time, sources }, index) => {
          const open = expanded === entity.entityId;
          const source = sources[0];
          return (
            <li key={entity.entityId} className="relative pb-7 pl-7">
              {index < list.length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-3 bottom-0 left-[5px] w-px bg-line"
                />
              )}
              <span
                aria-hidden
                className={`absolute top-1.5 left-0 h-[11px] w-[11px] rounded-full border-2 bg-paper ${
                  time ? "border-accent" : "border-ink-4"
                }`}
              />
              <div className="flex flex-wrap items-baseline gap-x-2 text-ui-sm">
                {time ? (
                  <span className="font-medium text-ink-2">{time}</span>
                ) : (
                  <span className="text-ink-3">时间尚不明确</span>
                )}
              </div>
              <Row
                active={selectedId === entity.entityId}
                onClick={() => {
                  onOpen(entity.entityId);
                  setExpanded(open ? null : entity.entityId);
                }}
                className="mt-0.5 flex items-center gap-2 px-2 py-1"
              >
                <span className="min-w-0 flex-1 font-prose text-ui-lg text-ink">
                  {entity.name}
                </span>
                <Icon
                  name="chevronDown"
                  className={`text-ink-3 transition-transform ${
                    open ? "rotate-180" : ""
                  }`}
                />
              </Row>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-ink-3">
                {[...new Set(sources.map((item) => item.chapterId))]
                  .slice(0, 3)
                  .map((id) => (
                    <Btn
                      key={id}
                      variant="link"
                      className="text-ui-sm"
                      onClick={() => onChapter(id)}
                    >
                      {chapterName(id, chapters)}
                    </Btn>
                  ))}
                <NatureTag nature={own[0]?.epistemic ?? "inference"} />
              </div>
              {(open || selectedId === entity.entityId) && source && (
                <div className="mt-3">
                  <SourceCard
                    source={source}
                    chapterLabel={chapterName(source.chapterId, chapters)}
                    onRead={onRead}
                    onChapter={(item) => onChapter(item.chapterId)}
                    clamp={false}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function HistorySection({
  records,
  query,
  kind,
  setKind,
  busy,
  onUndo,
  onNext,
  onFirst,
}: {
  records: Records;
  query: string;
  kind: string;
  setKind: (value: string) => void;
  busy: boolean;
  onUndo: (id: string) => void;
  onNext: () => void;
  onFirst: () => void;
}) {
  const rows = [
    ...(records.history?.items ?? []).map((change): HistoryRow => ({
      id: change.changeId,
      at: change.at,
      kind:
        change.kind === "sources_retired"
          ? "stale"
          : change.kind === "reanalysis_requested"
            ? "reanalyzed"
            : "extracted",
      title:
        change.kind === "sources_retired"
          ? "旧来源已失效"
          : change.kind === "reanalysis_requested"
            ? "你请求了重新分析"
            : "AI 重新整理了保存版本",
      detail:
        change.kind === "sources_retired"
          ? "旧引文保留在历史中，不再当作当前事实。"
          : `已处理章节 ${change.chapterId}`,
      technical: `changeId: ${change.changeId}\nrevisionId: ${change.revisionId || "-"}\njobId: ${change.jobId || "-"}`,
    })),
    ...(records.corrections?.items ?? []).map((correction): HistoryRow => ({
      id: correction.correctionId,
      at: correction.createdAt,
      kind: "correction",
      title:
        correction.action === "claim"
          ? "你把这句标成了角色说法"
          : correction.action === "separate"
            ? "你指出这里不是同一实体"
            : "你指出 AI 理解有误",
      detail: correction.reason,
      correction,
      technical: `correctionId: ${correction.correctionId}\nversion: ${correction.version}`,
    })),
    ...(records.jobs?.items ?? [])
      .filter((job) => job.status === "failed")
      .map((job): HistoryRow => ({
        id: job.jobId,
        at: job.completedAt || job.createdAt,
        kind: "failed",
        title: "一次知识分析没有完成",
        detail: `章节 ${job.chapterId}。正文仍然完整，可以单独重新分析。`,
        technical: `jobId: ${job.jobId}\nattempts: ${job.attempts}\nfailureCode: ${job.failureCode ?? "-"}\nreservedTokens: ${job.reservedTokens}`,
      })),
  ]
    .filter((row) => kind === "all" || row.kind === kind)
    .filter(
      (row) =>
        !query ||
        row.title.includes(query) ||
        row.detail.includes(query),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
  const groups = ["今天", "昨天", "本周", "更早"].map(
    (title) =>
      [
        title,
        rows.filter((row) => dayGroup(row.at) === title),
      ] as const,
  );
  return (
    <>
      <div className="scroll mb-6 overflow-x-auto">
        <Seg
          size="sm"
          label="记录类型"
          value={kind}
          onChange={setKind}
          options={[
            ["all", "全部"],
            ["extracted", "整理"],
            ["stale", "引用失效"],
            ["correction", "纠正"],
            ["reanalyzed", "重新分析"],
            ["failed", "失败"],
          ]}
        />
      </div>
      {!rows.length ? (
        <EmptyState
          icon="history"
          title="还没有相关记录"
          body="知识整理、引用失效、你的纠正和任务失败都会记在这里。"
        />
      ) : (
        groups.map(
          ([title, list]) =>
            list.length > 0 && (
              <section key={title} className="mb-8">
                <Heading level={3} className="mb-3">
                  {title}
                </Heading>
                <ol className="space-y-1">
                  {list.map((row) => {
                    const correction = row.correction;
                    return (
                      <li key={row.id} className="flex gap-3 rounded-lg px-1 py-2.5">
                        <span
                          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 ${
                            row.kind === "failed"
                              ? "text-danger"
                              : row.kind === "correction"
                                ? "text-accent"
                                : row.kind === "stale"
                                  ? "text-warn"
                                  : "text-ink-3"
                          }`}
                        >
                          <Icon
                            name={
                              row.kind === "failed" || row.kind === "stale"
                                ? "alert"
                                : row.kind === "correction"
                                  ? "edit"
                                  : row.kind === "reanalyzed"
                                    ? "refresh"
                                    : "layers"
                            }
                            className="h-3.5 w-3.5"
                          />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-ui text-ink">{row.title}</p>
                          <p className="mt-0.5 text-ui-sm text-ink-2">
                            {row.detail}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-micro text-ink-3">
                            <span>{formatAt(row.at)}</span>
                            {correction && (
                              <span>
                                {correction.active ? "生效中" : "已撤销"}
                              </span>
                            )}
                            {correction?.active && (
                              <Btn
                                variant="link"
                                className="text-micro"
                                disabled={busy}
                                onClick={() =>
                                  onUndo(correction.correctionId)
                                }
                              >
                                撤销
                              </Btn>
                            )}
                          </div>
                          <Disclosure label="详细信息" className="mt-1">
                            <pre className="whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 font-mono text-micro text-ink-3">
                              {row.technical}
                            </pre>
                          </Disclosure>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ),
        )
      )}
      <div className="flex gap-2">
        <Btn
          size="sm"
          onClick={onFirst}
          disabled={records.history?.nextCursor == null}
        >
          第一页记录
        </Btn>
        {records.history?.nextCursor != null && (
          <Btn size="sm" onClick={onNext}>
            下一页历史
          </Btn>
        )}
      </div>
    </>
  );
}

function Group({
  title,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  count: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!count) return null;
  return (
    <section className="mb-6">
      <Row
        onClick={() => setOpen((value) => !value)}
        className="-mx-2 flex items-center gap-2 px-2 py-1.5"
      >
        <Icon
          name="chevron"
          className={`h-3 w-3 text-ink-3 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <Heading level={3}>{title}</Heading>
        <span className="text-micro tabular-nums text-ink-3">{count}</span>
      </Row>
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </section>
  );
}

function EntityCard({
  entity,
  assertions,
  active,
  onOpen,
  source,
  onRead,
  footer,
  latest,
}: {
  entity: MemoryEntity;
  assertions: MemoryAssertion[];
  active: boolean;
  onOpen: () => void;
  source?: MemorySource;
  onRead: (source: MemorySource) => void;
  footer?: ReactNode;
  latest?: string;
}) {
  return (
    <article
      className={`rounded-lg border bg-surface px-4 py-3.5 ${
        active ? "border-accent/40" : "border-line-soft"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Btn
          variant="quiet"
          ariaLabel={`打开${entity.name}详情`}
          onClick={onOpen}
          className="-ml-2 min-w-0 justify-start px-2"
        >
          <span role="heading" aria-level={3} className="font-prose text-h3 text-ink">
            {entity.name}
          </span>
        </Btn>
        {entity.aliases.length > 0 && (
          <span className="text-ui-sm text-ink-3">
            又称 {entity.aliases.join("、")}
          </span>
        )}
        <span className="ml-auto text-micro text-ink-3">
          {entityType[entity.type]}
        </span>
      </div>
      {entity.identity && (
        <p className="mt-1 text-ui text-ink-2">{entity.identity}</p>
      )}
      {latest && (
        <p className="mt-0.5 line-clamp-1 text-ui-sm text-ink-3">
          近况：{latest}
        </p>
      )}
      {source && (
        <p className="mt-1 line-clamp-1 font-prose text-ui-sm text-ink-3">
          「{source.quote}」
        </p>
      )}
      {footer ? (
        <div className="mt-2">{footer}</div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-x-3 text-micro text-ink-3">
          {assertions.length > 0 && <span>{assertions.length} 条知识</span>}
          {source && (
            <Btn
              variant="link"
              className="text-micro"
              ariaLabel={`${source.chapterId} · 查看原文依据`}
              onClick={() => onRead(source)}
            >
              查看原文依据
            </Btn>
          )}
        </div>
      )}
    </article>
  );
}

function uniqueSources(assertions: MemoryAssertion[]) {
  const seen = new Set<string>();
  return assertions
    .flatMap((assertion) => assertion.sources)
    .filter((source) => {
      const key = `${source.chapterId}\0${source.revisionId}\0${source.startUTF16}\0${source.endUTF16}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function groupEntities(entities: MemoryEntity[]): [string, MemoryEntity[]][] {
  return [
    ["人物", entities.filter((entity) => entity.type === "character")],
    ["事件", entities.filter((entity) => entity.type === "event")],
    [
      "世界与规则",
      entities.filter((entity) =>
        ["place", "organization", "world_rule"].includes(entity.type),
      ),
    ],
    [
      "剧情线与伏笔",
      entities.filter((entity) =>
        ["plot_line", "foreshadowing"].includes(entity.type),
      ),
    ],
  ];
}

function emptyRecords(): Records {
  return { jobs: null, history: null, corrections: null };
}

function emptyPage(view: MemoryView, bookId: string): MemoryPage {
  return {
    ...view,
    bookId,
    entities: [],
    assertions: [],
    total: 0,
    nextCursor: null,
    assertionTotal: 0,
    nextAssertionCursor: null,
  };
}

function chapterName(
  id: string,
  chapters: { id: string; title: string }[],
) {
  return chapters.find((chapter) => chapter.id === id)?.title || id;
}

function chapterNo(chapter: { title: string }) {
  const sequence = chapter.title.match(/^第\s*(\d+)\s*章/)?.[1];
  return sequence ? `第${sequence}章` : chapter.title;
}

function formatAt(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? ago(time) : value;
}

function dayGroup(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "更早";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return "今天";
  if (time >= start.getTime() - 86_400_000) return "昨天";
  if (time >= start.getTime() - 6 * 86_400_000) return "本周";
  return "更早";
}

function friendlyKnowledgeError(
  cause: unknown,
  fallback = "作品记忆暂时无法读取，请稍后重试。",
) {
  if (!(cause instanceof Error) || !cause.message.trim()) return fallback;
  if (
    /JSON|validation|unrecognized|parse|schema|Assertion|TypeError|ZodError/i.test(
      cause.message,
    )
  )
    return "作品记忆响应格式已更新，请刷新页面后重试。";
  return cause.message;
}
