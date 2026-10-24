// Browser → actual workerd/D1 → production-mode Go → independent Pi SDK → fixture LLM.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { makeSignature } from "better-auth/crypto";
import { chromium, expect } from "@playwright/test";
import {
  startThinkingFixture,
  seedThinkingBook,
} from "../../../scripts/lib/thinking-fixture.mjs";
const root = await mkdtemp(join(tmpdir(), "story2u-release-"));
const origin = "https://writer.example",
  secret = "isolated-release-secret-with-no-production-credentials";
let mf, browser, fixture;
const run = (args, env = {}) => {
  const r = spawnSync("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env },
  });
  assert.equal(r.status, 0);
};
try {
  fixture = await startThinkingFixture();
  const bearer = fixture.bearer,
    book = await seedThinkingBook(fixture);
  const assets = join(root, "assets");
  run(["exec", "vite", "build", "--outDir", assets], {
    VITE_WRITER_AGENT_MODE: "api",
    VITE_WRITER_AGENT_AUTH: "google",
    VITE_STORY2U_PUBLIC_SITE: "true",
    VITE_WRITER_AGENT_PROJECT_ID: "empty-external",
  });
  run([
    "exec",
    "wrangler",
    "deploy",
    "--dry-run",
    "--assets",
    assets,
    "--outdir",
    join(root, "bundle"),
  ]);
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: join(root, "bundle"),
      scriptPath: join(root, "bundle/index.js"),
      compatibilityDate: "2026-10-17",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { AUTH_DB: "release-isolated" },
      bindings: {
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: secret,
        GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "fixture",
        WRITER_AGENT_AUTHOR_EMAILS: "author@example.com",
        WRITER_AGENT_PROJECT_ID: "empty-external",
        WRITER_AGENT_API_TOKEN: bearer,
        WRITER_AGENT_API_ORIGIN: "https://api.example",
      },
      outboundService: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.example");
        assert.equal(request.headers.has("cookie"), false);
        if (!url.pathname.startsWith("/v1/public/"))
          assert.equal(
            request.headers.get("authorization"),
            "Bearer " + bearer,
          );
        else assert.equal(request.headers.has("authorization"), false);
        const headers = new Headers(request.headers);
        for (const key of [
          "host",
          "content-length",
          "transfer-encoding",
          "connection",
        ])
          headers.delete(key);
        const response = await fetch(fixture.api + url.pathname + url.search, {
          method: request.method,
          headers,
          ...(request.method !== "GET" && request.method !== "HEAD"
            ? { body: await request.arrayBuffer() }
            : {}),
        });
        if (response.status >= 400)
          console.log(
            "Fixture Go response",
            request.method,
            url.pathname,
            response.status,
            await response.clone().text(),
          );
        return response;
      },
      serviceBindings: {
        ASSETS: async (request) => {
          const path = new URL(request.url).pathname;
          const file =
            path.startsWith("/assets/") ||
            path === "/favicon.svg" ||
            path === "/og.svg"
              ? path.slice(1)
              : "index.html";
          const target = resolve(assets, file);
          assert.ok(target.startsWith(assets + "/"));
          try {
            return new Response(await readFile(target), {
              headers: {
                "content-type":
                  {
                    ".html": "text/html",
                    ".js": "application/javascript",
                    ".css": "text/css",
                    ".svg": "image/svg+xml",
                  }[extname(file)] ?? "application/octet-stream",
              },
            });
          } catch {
            return new Response("Not found", { status: 404 });
          }
        },
      },
    }),
  );
  const db = await mf.getD1Database("AUTH_DB");
  await db.exec(
    (
      await readFile(
        new URL("../migrations/0001_better_auth.sql", import.meta.url),
        "utf8",
      )
    )
      .replace(/^--.*$/gm, "")
      .trim(),
  );
  const now = Date.now(),
    token = "isolated-google-session";
  await db
    .prepare(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    )
    .bind("fixture-user", "Fixture Author", "author@example.com", 1, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    )
    .bind("fixture-session", token, "fixture-user", now + 3600000, now, now)
    .run();
  const signed = encodeURIComponent(
      token + "." + (await makeSignature(token, secret)),
    ),
    cookie = "__Secure-better-auth.session_token=" + signed;
  const call = (path, data, auth = true) =>
    mf.dispatchFetch(origin + path, {
      method: data ? "POST" : "GET",
      headers: {
        ...(auth ? { cookie } : {}),
        ...(data
          ? {
              origin,
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
            }
          : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  assert.equal((await call("/v1/studio/books", undefined, false)).status, 401);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "__Secure-better-auth.session_token",
      value: signed,
      url: origin,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  async function route(ctx) {
    await ctx.route("**/*", async (route) => {
      const r = route.request();
      if (!r.url().startsWith(origin + "/")) return route.abort();
      const response = await mf.dispatchFetch(r.url(), {
        method: r.method(),
        headers: await r.allHeaders(),
        ...(r.postDataBuffer() ? { body: r.postDataBuffer() } : {}),
        redirect: "manual",
      });
      if (response.status >= 400)
        console.log(
          "Fixture Worker response",
          r.method(),
          new URL(r.url()).pathname,
          response.status,
          await response.clone().text(),
        );
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
  }
  await route(context);
  await context.addInitScript(
    (id) => sessionStorage.setItem("writer-agent:selected-book", id),
    book.bookId,
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/studio");
  await expect(page.getByLabel("正文编辑器")).toBeVisible();
  await page.getByRole("tab", { name: "思考", exact: true }).click();
  await expect(page.getByText("确认这次思考的数据范围")).toBeVisible();
  await page.getByRole("button", { name: "同意以上范围并创建会话" }).click();
  const input = page.getByLabel("创作问题");
  await expect(input).toBeVisible();
  await input.fill("林舟与父亲的关系变化是否合理？");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(
    page.getByText("林舟与父亲从争执到理解，可能由信息差与保护动机推动；", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel("思考 Agent").locator("details")).toHaveCount(3);
  await page
    .getByLabel("思考 Agent")
    .locator("details")
    .first()
    .locator("summary")
    .click();
  await expect(page.getByText(/Revision /).first()).toBeVisible();
  await input.fill("那么父亲还有什么其他解释？");
  await expect(
    page.getByRole("button", { name: "发送问题", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByLabel("思考 Agent").locator("article")).toHaveCount(4, { timeout: 20000 });
  await expect(page.getByLabel("思考 Agent").locator("article").last()).toContainText("已完成", {
    timeout: 20000,
  });
  await page.reload();
  await page.getByRole("tab", { name: "思考", exact: true }).click();
  await expect(page.getByLabel("思考 Agent").locator("article")).toHaveCount(4);
  fixture.config.hang = true;
  await input.fill("取消这次思考");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await page.getByRole("button", { name: "取消思考", exact: true }).click();
  await expect(page.getByLabel("思考 Agent").locator("article").last()).toContainText("已取消");
  fixture.config.hang = false;
  await fixture.stopAgent();
  await input.fill("服务离线时不重复接受");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("输入已保留");
  await page.getByRole("tab", { name: "写作", exact: true }).click();
  await page
    .getByLabel("正文编辑器")
    .fill("独立 Pi Agent 离线，正文仍然可以保存。");
  await expect(page.getByText(/^已保存 /)).toBeVisible();
  await fixture.restartAgent();
  await page.getByRole("tab", { name: "思考", exact: true }).click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByLabel("思考 Agent").locator("article").last()).toContainText("已完成", {
    timeout: 20000,
  });
  const screenshot = resolve("test-results-thinking/thinking-desktop.png");
  await mkdir(resolve("test-results-thinking"), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve("test-results-thinking/thinking-mobile.png"),
    fullPage: true,
  });
  // History and deletion remain available even when capabilities/snapshot RPC fail.
  await fixture.stopAgent();
  await page.reload();
  await page.getByRole("tab", { name: "思考", exact: true }).click();
  await expect(page.getByLabel("历史思考会话").locator("option")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "删除会话", exact: true })).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除会话", exact: true }).click();
  await expect(page.getByLabel("历史思考会话").locator("option")).toHaveCount(1);
  await fixture.restartAgent();
  assert.deepEqual(errors, []);
  assert.equal(
    (await call("/internal/v1/agent/tools/execute", {})).status,
    404,
  );
  console.log(
    "PASS: signed-session Browser → actual Cloudflare Worker/D1 → Go → Pi SDK tools/LLM fixture. Consent, evidence, multi-turn, refresh, cancel, offline history/deletion and writing while Agent offline verified. No paid model called.",
  );
} finally {
  await browser?.close();
  await mf?.dispose();
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
}
