import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
  within,
} from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { KnowledgePanel } from "../features/knowledge/KnowledgePanel";
import { knowledgeApi } from "../services/api/knowledgeApi";
import type { MemoryPage } from "@writer-agent/contracts";
import type { WriterAgentAdapter } from "../services/writerAgent";
const model = {
  provider: "openai-compatible",
  model: "fixture",
  endpoint: "http://localhost",
  execution: "local",
};
function page(book = "book-a"): MemoryPage {
  return {
    bookId: book,
    version: 1,
    budgetDay: "",
    budgetTokens: 0,
    budgetAttempts: 0,
    settings: {
      enabled: true,
      paused: false,
      model,
      dailyTokenBudget: 100000,
      dailyJobBudget: 20,
    },
    available: true,
    model,
    disclosure: "已保存正文会发送到模型，会产生费用。",
    pending: 0,
    running: 0,
    failed: 0,
    stale: false,
    assertionTotal: 1,
    nextAssertionCursor: null,
    total: 1,
    nextCursor: null,
    entities: [
      {
        entityId: "entity-1",
        bookId: book,
        type: "character",
        name: book === "book-a" ? "林舟" : "阿宁",
        aliases: [],
        identity: "",
        status: "observed",
        createdAt: "now",
        updatedAt: "now",
        version: 1,
      },
    ],
    assertions: [
      {
        assertionId: "assertion-1",
        entityId: "entity-1",
        predicate: "年龄",
        text: "林舟十五岁离开北港。",
        epistemic: "observation",
        status: "current",
        sources: [
          {
            bookId: book,
            chapterId: "CH-001",
            revisionId: "draft:1",
            contentHash: "hash",
            quote: "林舟十五岁离开北港。",
            startUTF16: 0,
            endUTF16: 10,
            sourceKind: "narration",
            validity: "current",
          },
        ],
      },
    ],
  };
}
const adapter = {
  mode: "api",
  loadChapter: vi.fn(),
} as unknown as WriterAgentAdapter;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(knowledgeApi, "query").mockResolvedValue(page());
  vi.spyOn(knowledgeApi, "summary").mockResolvedValue(page());
  vi.spyOn(knowledgeApi, "jobs").mockResolvedValue({
    items: [],
    total: 0,
    nextCursor: null,
  });
  vi.spyOn(knowledgeApi, "history").mockResolvedValue({
    items: [],
    total: 0,
    nextCursor: null,
  });
  vi.spyOn(knowledgeApi, "corrections").mockResolvedValue({
    items: [],
    total: 0,
    nextCursor: null,
  });
  vi.spyOn(knowledgeApi, "mutate").mockResolvedValue(page());
});
const props = {
  bookId: "book-a",
  chapterId: "CH-001",
  section: "people" as const,
  adapter,
  onChapter: vi.fn(),
};
describe("private AI memory", () => {
  it("renders sourced observations, not confirmed canon, and queries only current section", async () => {
    render(<KnowledgePanel {...props} />);
    expect(await screen.findByRole("heading", { name: "林舟" })).toBeVisible();
    expect(
      screen.getByText(/「林舟十五岁离开北港。/),
    ).toBeVisible();
    expect(knowledgeApi.query).toHaveBeenCalledWith(
      "book-a",
      expect.any(URLSearchParams),
      expect.any(AbortSignal),
    );
    expect(vi.mocked(knowledgeApi.query).mock.calls[0][1].get("type")).toBe(
      "character",
    );
    expect(knowledgeApi.jobs).not.toHaveBeenCalled();
    expect(knowledgeApi.history).not.toHaveBeenCalled();
    expect(knowledgeApi.corrections).not.toHaveBeenCalled();
  });
  it("requires per-book explicit model disclosure consent before enable", async () => {
    const p = page();
    p.settings.enabled = false;
    p.entities = [];
    p.assertions = [];
    p.total = 0;
    vi.mocked(knowledgeApi.query).mockResolvedValue(p);
    render(<KnowledgePanel {...props} />);
    await screen.findByText("启用知识维护后开始整理");
    fireEvent.click(screen.getByRole("button", { name: "启用自动整理" }));
    expect(screen.getByRole("button", { name: "确认启用" })).toBeDisabled();
    expect(screen.getByText(p.disclosure)).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "每日 Token 上限（保守预留）" }),
    ).toHaveValue("100000");
    expect(
      screen.getByRole("textbox", {
        name: "每日执行次数上限（含失败与重试）",
      }),
    ).toHaveValue("20");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认启用" }));
    await waitFor(() =>
      expect(knowledgeApi.mutate).toHaveBeenCalledWith(
        "book-a",
        "enable",
        expect.objectContaining({
          consent: true,
          model,
          dailyTokenBudget: 100000,
          dailyJobBudget: 20,
        }),
      ),
    );
  });
  it("shows stale status and background work without blocking author", async () => {
    const p = page();
    p.pending = 2;
    p.stale = true;
    p.assertions[0].status = "stale";
    p.assertions[0].sources[0].validity = "stale";
    vi.mocked(knowledgeApi.query).mockResolvedValue(p);
    render(<KnowledgePanel {...props} />);
    expect(await screen.findByText(/2 章等待分析/)).toBeVisible();
    expect(screen.getByText(/部分来源已过期/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开林舟详情" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "CH-001 · 查看原文依据",
      }),
    );
    expect(screen.getByLabelText("原文证据")).toHaveTextContent("旧版本证据");
  });
  it("does not let an old work response replace a new work", async () => {
    let resolveA: (p: MemoryPage) => void = () => {};
    const old = new Promise<MemoryPage>((r) => {
      resolveA = r;
    });
    vi.mocked(knowledgeApi.query).mockImplementation((id) =>
      id === "book-a" ? old : Promise.resolve(page("book-b")),
    );
    const view = render(<KnowledgePanel key="a" {...props} />);
    view.rerender(<KnowledgePanel key="b" {...props} bookId="book-b" />);
    expect(await screen.findByRole("heading", { name: "阿宁" })).toBeVisible();
    await act(async () => resolveA(page()));
    expect(
      screen.queryByRole("heading", { name: "林舟" }),
    ).not.toBeInTheDocument();
  });
  it("offers retry after API failure and records optional correction", async () => {
    vi.mocked(knowledgeApi.query).mockRejectedValueOnce(Error("暂时不可用"));
    render(<KnowledgePanel {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "知识暂时无法加载",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "林舟" });
    fireEvent.click(screen.getByRole("button", { name: "打开林舟详情" }));
    fireEvent.click(screen.getByRole("button", { name: "纠正这一条" }));
    fireEvent.click(screen.getByRole("button", { name: "这是角色说法" }));
    expect(screen.queryByRole("button", { name: "保存纠错" })).toBeNull();
    await waitFor(() =>
      expect(knowledgeApi.mutate).toHaveBeenCalledWith(
        "book-a",
        "correct",
        expect.objectContaining({
          action: "claim",
          assertionId: "assertion-1",
        }),
      ),
    );
    expect(await screen.findByText("你的纠正已保存，可以随时撤销。")).toBeVisible();
  });
  it("loads background records only for history and caches an unchanged section", async () => {
    const view = render(<KnowledgePanel {...props} />);
    await screen.findByRole("heading", { name: "林舟" });
    expect(knowledgeApi.jobs).not.toHaveBeenCalled();

    vi.mocked(knowledgeApi.jobs).mockClear();
    vi.mocked(knowledgeApi.history).mockClear();
    vi.mocked(knowledgeApi.corrections).mockClear();
    view.rerender(<KnowledgePanel {...props} section="history" />);
    await waitFor(() =>
      expect(knowledgeApi.history).toHaveBeenCalledWith(
        "book-a",
        expect.any(AbortSignal),
        0,
      ),
    );
    expect(knowledgeApi.jobs).toHaveBeenCalled();
    expect(knowledgeApi.summary).toHaveBeenCalled();
    expect(knowledgeApi.query).toHaveBeenCalledTimes(1);
    expect(knowledgeApi.corrections).toHaveBeenCalled();
  });
  it("loads facts on demand when a typed-category entity opens", async () => {
    const list = page();
    const initialEntity = list.entities[0];
    list.entities = [
      initialEntity,
      {
        ...initialEntity,
        entityId: "entity-2",
        name: "阿宁",
      },
    ];
    list.total = 2;
    list.assertions = [];
    list.assertionTotal = 0;
    vi.mocked(knowledgeApi.query)
      .mockResolvedValueOnce(list)
      .mockResolvedValueOnce({
        ...list,
        entities: [initialEntity],
        assertions: page().assertions,
        total: 1,
        assertionTotal: 1,
      });

    render(<KnowledgePanel {...props} />);
    await screen.findByRole("heading", { name: "林舟" });
    fireEvent.click(screen.getByRole("button", { name: "打开林舟详情" }));

    await screen.findByText(/「林舟十五岁离开北港。/);
    expect(knowledgeApi.query).toHaveBeenCalledTimes(2);
    expect(vi.mocked(knowledgeApi.query).mock.calls[1][3]).toBe(
      "/entities/entity-1",
    );
    expect(
      vi.mocked(knowledgeApi.query).mock.calls[1][1].get("assertionCursor"),
    ).toBe("0");
  });

  it("retries a failed entity detail request", async () => {
    const list = page();
    list.assertions = [];
    list.assertionTotal = 0;
    vi.mocked(knowledgeApi.query)
      .mockResolvedValueOnce(list)
      .mockRejectedValueOnce(Error("detail failed"))
      .mockResolvedValueOnce({ ...list, assertions: page().assertions });

    render(<KnowledgePanel {...props} />);
    await screen.findByRole("heading", { name: "林舟" });
    fireEvent.click(screen.getByRole("button", { name: "打开林舟详情" }));
    expect(
      await screen.findByText("详情暂时无法读取；名称与分类仍可查看。"),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(knowledgeApi.query).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/「林舟十五岁离开北港。/)).toBeVisible();
  });

  it("ignores a late detail response after another entity is selected", async () => {
    const list = page();
    const first = list.entities[0];
    const second = { ...first, entityId: "entity-2", name: "阿宁" };
    list.entities = [first, second];
    list.total = 2;
    list.assertions = [];
    list.assertionTotal = 0;
    let resolveFirst: (value: MemoryPage) => void = () => {};
    const firstDetail = new Promise<MemoryPage>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(knowledgeApi.query)
      .mockResolvedValueOnce(list)
      .mockImplementationOnce(() => firstDetail)
      .mockResolvedValueOnce({
        ...list,
        entities: [second],
        assertions: [
          {
            ...page().assertions[0],
            assertionId: "assertion-2",
            entityId: "entity-2",
            text: "阿宁来到江宁。",
            sources: [
              {
                ...page().assertions[0].sources[0],
                quote: "阿宁来到江宁。",
                endUTF16: 7,
              },
            ],
          },
        ],
      });

    render(<KnowledgePanel {...props} />);
    await screen.findByRole("heading", { name: "林舟" });
    fireEvent.click(screen.getByRole("button", { name: "打开林舟详情" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    fireEvent.click(screen.getByRole("button", { name: "打开阿宁详情" }));
    expect((await screen.findAllByText("阿宁来到江宁。"))[0]).toBeVisible();
    expect(vi.mocked(knowledgeApi.query).mock.calls.map((call) => call[3])).toEqual([
      undefined,
      "/entities/entity-1",
      "/entities/entity-2",
    ]);

    await act(async () => resolveFirst(page()));
    expect(
      screen.queryByText("林舟十五岁离开北港。"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("阿宁来到江宁。")[0]).toBeVisible();
  });

  it("uses the author's correction when labeling a detail assertion", async () => {
    vi.mocked(knowledgeApi.corrections).mockResolvedValue({
      items: [
        {
          correctionId: "correction-1",
          assertionId: "assertion-1",
          entityId: "entity-1",
          chapterId: "CH-001",
          action: "claim",
          reason: "这是角色自己的说法。",
          actorId: "author",
          active: true,
          version: 1,
          createdAt: "now",
        },
      ],
      total: 1,
      nextCursor: null,
    });

    render(<KnowledgePanel {...props} />);
    await screen.findByRole("heading", { name: "林舟" });
    fireEvent.click(screen.getByRole("button", { name: "打开林舟详情" }));

    const detail = screen.getByLabelText("知识详情");
    expect(
      await within(detail).findByRole("heading", { name: "角色说法" }),
    ).toBeVisible();
    expect(within(detail).queryByText("正文观察")).not.toBeInTheDocument();
  });

  it("polls again when enable succeeds before background work is queued", async () => {
    const disabled = page();
    disabled.settings.enabled = false;
    disabled.entities = [];
    disabled.assertions = [];
    disabled.total = 0;
    disabled.assertionTotal = 0;
    const enabledNoWork = {
      ...disabled,
      settings: { ...disabled.settings, enabled: true },
    };
    const running = page();
    running.pending = 1;
    vi.mocked(knowledgeApi.query).mockResolvedValue(disabled);
    vi.mocked(knowledgeApi.summary)
      .mockResolvedValueOnce(disabled)
      .mockResolvedValueOnce(enabledNoWork)
      .mockResolvedValue(running);
    vi.mocked(knowledgeApi.mutate).mockResolvedValue({
      ...disabled,
      settings: { ...disabled.settings, enabled: true },
    });

    render(<KnowledgePanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "启用自动整理" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认启用" }));

    await waitFor(
      () =>
        expect(
          vi.mocked(knowledgeApi.summary).mock.calls.length,
        ).toBeGreaterThanOrEqual(3),
      { timeout: 4000 },
    );
    expect(
      vi.mocked(knowledgeApi.query).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });
  it("probes once when a newly opened view has no queued work yet", async () => {
    const initial = page();
    const queued = page();
    queued.pending = 1;
    vi.mocked(knowledgeApi.query).mockResolvedValue(initial);
    vi.mocked(knowledgeApi.summary)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(queued);

    render(<KnowledgePanel {...props} />);
    await screen.findByRole("heading", { name: "林舟" });
    await waitFor(
      () =>
        expect(knowledgeApi.summary).toHaveBeenCalledTimes(2),
      { timeout: 2500 },
    );
    await waitFor(
      () => expect(knowledgeApi.query).toHaveBeenCalledTimes(2),
      { timeout: 2500 },
    );
  });
  it.each([
    ["world", "place,organization,world_rule"],
    ["timeline", "event"],
    ["plot", "plot_line"],
    ["threads", "foreshadowing"],
    ["chapter", null],
  ] as const)(
    "filters %s without fetching the whole memory",
    async (section, type) => {
      render(<KnowledgePanel {...props} section={section} />);
      await waitFor(() =>
        expect(knowledgeApi.query).toHaveBeenCalledTimes(1),
      );
      const q = vi.mocked(knowledgeApi.query).mock.calls[0][1];
      expect(q.get("type")).toBe(type);
      if (section === "chapter") expect(q.get("chapterId")).toBe("CH-001");
      expect(q.get("assertionCursor")).toBe("0");
    },
  );
});
