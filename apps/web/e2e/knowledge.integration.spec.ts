import { test, expect, type Page } from "@playwright/test";
async function book(page: Page) {
  await page.getByRole("tab", { name: "书", exact: true }).click();
  await expect(page.getByLabel("自动作品知识")).toBeVisible();
}
async function people(page: Page) {
  await page
    .getByRole("navigation", { name: "书的分区" })
    .getByRole("button", { name: "人物", exact: true })
    .click();
}
test("saved prose automatically becomes private memory, links chapter two, revises and survives refresh", async ({
  page,
  request,
}) => {
  const r = await request.post("/v1/studio/books", {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { operation: "create", baseVersion: 0, title: "合成知识验证" },
  });
  expect(r.status()).toBe(201);
  const work = await r.json();
  await page.addInitScript(
    (id) => sessionStorage.setItem("writer-agent:selected-book", id),
    work.bookId,
  );
  await page.goto("/studio?view=read&compose=1");
  const editor = page.getByLabel("正文编辑器");
  await expect(editor).toBeVisible();
  const ch1 = work.chapters[0].chapterId;
  const savedMarkdown = async (chapterId: string) => {
    const response = await request.get(
      `/v1/projects/${work.bookId}/chapters/${chapterId}`,
    );
    expect(response.ok()).toBe(true);
    return (await response.json()).headRevision.markdown;
  };
  await editor.fill("林舟十五岁离开北港。");
  await expect
    .poll(() => savedMarkdown(ch1), { timeout: 10000 })
    .toBe("林舟十五岁离开北港。");
  await book(page);
  await expect(page.getByText("启用知识维护后开始整理")).toBeVisible();
  await page.getByRole("button", { name: "启用自动整理" }).click();
  await page.getByLabel("每日 Token 上限（保守预留）").fill("200000");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "确认启用" }).click();
  await people(page);
  await expect(
    page.getByRole("heading", { name: "林舟", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page
    .getByRole("button", { name: "打开林舟详情" })
    .click();
  await page
    .getByLabel("知识详情")
    .getByRole("button", { name: /查看原文依据/ })
    .first()
    .click();
  await expect(page.getByLabel("原文证据").locator("mark")).toHaveText(
    "林舟十五岁离开北港。",
  );
  const root = `/v1/studio/books/${work.bookId}/knowledge`;
  const waitForCurrentKnowledge = (text: string) =>
    expect
      .poll(
        async () => {
          const response = await request.get(`${root}?limit=100`);
          expect(response.ok()).toBe(true);
          const current = await response.json();
          return current.assertions.some(
            (item: { status: string; text: string }) =>
              item.status === "current" && item.text.includes(text),
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
  const next = await request.put(`/v1/studio/books/${work.bookId}/structure`, {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { operation: "chapter", baseVersion: work.version },
  });
  expect(next.status()).toBe(200);
  const two = await next.json();
  const ch2 = two.chapters[1].chapterId;
  // Author saves a second chapter via the real editor after refreshing the directory.
  // V3 keeps the current space in the URL, so reopen the reading/compose space.
  await page.goto("/studio?view=read&compose=1");
  await expect(editor).toBeVisible();
  const toggle = page.getByRole("button", { name: "目录与本章相关" });
  if ((await toggle.getAttribute("aria-pressed")) !== "true")
    await toggle.click();
  await page.getByRole("button", { name: "第2章", exact: true }).click();
  await editor.fill("林舟来到江宁。");
  await expect
    .poll(() => savedMarkdown(ch2), { timeout: 10000 })
    .toBe("林舟来到江宁。");
  await waitForCurrentKnowledge("林舟来到江宁。");
  // The Worker has completed. Reload once so this assertion exercises the
  // finished knowledge response instead of the exact timing of the 15s poll.
  await page.reload();
  await book(page);
  await people(page);
  await expect(
    page
      .getByLabel("自动作品知识")
      .getByText(/林舟来到江宁。/)
      .first(),
  ).toBeVisible({
    timeout: 20000,
  });
  await expect(
    page.getByRole("heading", { name: "林舟", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "回到正文" }).click();
  await page.getByRole("button", { name: "第一章", exact: true }).click();
  await editor.fill("林舟十六岁离开北港。");
  await expect
    .poll(() => savedMarkdown(ch1), { timeout: 10000 })
    .toBe("林舟十六岁离开北港。");
  await waitForCurrentKnowledge("林舟十六岁离开北港。");
  await page.reload();
  await book(page);
  await people(page);
  await expect(
    page
      .getByLabel("自动作品知识")
      .getByText(/林舟十六岁离开北港。/)
      .first(),
  ).toBeVisible({ timeout: 20000 });
  const memory = await (await request.get(root + "?limit=100")).json();
  expect(
    memory.assertions
      .filter((a: { status: string; text: string }) => a.status === "current")
      .some((a: { text: string }) => a.text.includes("十五")),
  ).toBe(false);
  const saved = await (
    await request.get(`/v1/projects/${work.bookId}/chapters/${ch2}`)
  ).json();
  expect(saved.headRevision.markdown).toBe("林舟来到江宁。");
  const pub = await (await request.get("/v1/public/home")).text();
  expect(pub).not.toContain("entityId");
  expect(pub).not.toContain("assertionId");
  expect(pub).not.toContain("林舟");
  await page.screenshot({
    path: "/tmp/story2u-knowledge-synthetic.png",
    fullPage: true,
  });
});
