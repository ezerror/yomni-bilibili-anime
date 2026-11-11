import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const host = (process.env.YOMNI_HOST_ROOT ?? process.env.PAL_HOST_ROOT) ?? resolve(root, "../../pal");
const desktop = join(host, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron, expect } = require("@playwright/test");
const { prepareBundledPlugins } = await import(
  pathToFileURL(join(host, "tools/bundled-plugins.mjs")).href
);
const bundled = await prepareBundledPlugins();
const artifacts = join(root, "artifacts/desktop");
const data = join(artifacts, `profile-${Date.now()}`);
await mkdir(data, { recursive: true });
const messages = [],
  errors = [],
  stderr = [];
let app,
  keepOpen = false;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  messages.push(input);
  const last = input.messages?.at(-1);
  let delta;
  if (last?.role === "tool") {
    let content;
    try {
      content = JSON.parse(last.content);
    } catch {
      content = {};
    }
    delta = { content: content.directive ?? `Search failed: ${last.content}` };
  } else {
    delta = {
      tool_calls: [
        {
          index: 0,
          id: `bilibili-${messages.length}`,
          type: "function",
          function: {
            name: "bilibili_search_anime",
            arguments: JSON.stringify({
              keyword: "葬送的芙莉莲",
              max_seasons: 5,
            }),
          },
        },
      ],
    };
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

try {
  const env = {
    ...process.env,
    YOMNI_DATA_DIR: data,
    YOMNI_PLUGINS_DIR: bundled,
    YOMNI_TRUSTED_CORE_PLUGINS_DIR: bundled,
    YOMNI_DEFAULT_CONFIG: join(desktop, "config/default.yml"),
    ELECTRON_RENDERER_URL: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [desktop, "--remote-debugging-port=9867"],
    env,
    timeout: 60000,
  });
  app.process().stderr.on("data", (value) => stderr.push(String(value)));
  let page = await app.firstWindow();
  await page.waitForFunction(() => !!window.pal?.userAccounts, {
    timeout: 60000,
  });
  if (
    (await page.evaluate(() => window.pal.userAccounts.session())).setupRequired
  ) {
    // Create a synthetic local test account through the normal application API.
    await page.evaluate(() =>
      window.pal.userAccounts.setup({
        username: "anime-preview",
        displayName: "Bilibili plugin preview",
        password: "Local-preview-only-2026!",
      }),
    );
    await expect
      .poll(
        () =>
          app
            .windows()
            .find(
              (item) =>
                !item.isClosed() &&
                !item.url().includes("#account") &&
                item.url().includes("/renderer/index.html"),
            ),
        { timeout: 60000 },
      )
      .toBeTruthy();
    page = app
      .windows()
      .find(
        (item) =>
          !item.isClosed() &&
          !item.url().includes("#account") &&
          item.url().includes("/renderer/index.html"),
      );
  }
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.pal?.plugins, { timeout: 60000 });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
    // The fixture explicitly enables its own provider in an isolated profile.
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) =>
      args.some((arg) => arg?.message?.includes("Default Agent"))
        ? { response: 1, checkboxChecked: false }
        : original(...args);
  }, root);
  console.log(
    "IMPORT",
    JSON.stringify(
      await page.evaluate(() => window.pal.plugins.importDirectory()),
    ),
  );
  console.log(
    "ENABLE",
    JSON.stringify(
      await page.evaluate(async () => {
        const ticket = await window.pal.plugins.prepareEnable(
          "pal.bilibili-anime",
          null,
          true,
        );
        if (!ticket.ok) return ticket;
        return window.pal.plugins.setEnabled(
          "pal.bilibili-anime",
          null,
          true,
          ticket.value.token,
        );
      }),
    ),
  );
  const status = await page.evaluate(async () => {
    const item = (await window.pal.plugins.list("default")).plugins.find(
      (entry) => entry.manifest.id === "pal.bilibili-anime",
    );
    return { state: item?.state, error: item?.error };
  });
  console.log("PLUGIN_STATUS", JSON.stringify(status));
  if (status.state === "error") throw new Error(status.error);
  await page.evaluate(async (baseUrl) => {
    await window.pal.models.saveProfile({
      name: "Local preview",
      protocol: "openai-chat",
      baseUrl,
      defaultModel: "preview",
      models: ["preview"],
      apiKey: "local-test-only",
    });
    const ticket = await window.pal.plugins.prepareEnable(
      "pal.default-agent",
      null,
      true,
    );
    if (ticket.ok)
      await window.pal.plugins.setEnabled(
        "pal.default-agent",
        null,
        true,
        ticket.value.token,
      );
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.reload();
  await page.evaluate(() => {
    document.title = "Yomni Bilibili Plugin Preview";
  });
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("搜索哔哩哔哩番剧：葬送的芙莉莲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  // Search is read-only; allow the known fixture request if normal execution asks.
  const approval = page.getByRole("button", { name: "允许", exact: true });
  for (let count = 0; count < 80; count++) {
    if (await page.locator('[data-testid="anime-player"]').count()) break;
    if (
      await approval
        .first()
        .isVisible()
        .catch(() => false)
    )
      await approval.first().click();
    await page.waitForTimeout(500);
  }
  const player = page.locator('[data-testid="anime-player"]');
  await expect(player).toBeVisible({ timeout: 30000 });
  await expect(player.locator(".anime-episodes button")).not.toHaveCount(0);
  await player.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await player
    .getByRole("button", { name: "葬送的芙莉莲", exact: true })
    .click();
  await expect(player.locator(".anime-heading strong")).toHaveText(
    "葬送的芙莉莲",
  );
  const episodeLabels = await player
    .locator(".anime-episodes button")
    .allTextContents();
  const numberedEpisodes = episodeLabels.filter((label) => /^\d+$/.test(label));
  if (new Set(numberedEpisodes).size !== numberedEpisodes.length)
    throw new Error("Episode list contains duplicate preview entries");
  const twentyThree = player
    .locator(".anime-episodes")
    .getByRole("button", { name: "23", exact: true });
  await twentyThree.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await twentyThree.click();
  await expect(player.locator(".anime-episode-number")).toHaveText("23");
  await player.getByRole("button", { name: "下一集", exact: true }).click();
  await expect(player.locator(".anime-episode-number")).toHaveText("24");
  await player.getByRole("button", { name: "上一集", exact: true }).click();
  await expect(player.locator(".anime-episode-number")).toHaveText("23");
  const requestCount = messages.length;
  await page.reload();
  await expect(player.locator(".anime-episode-number")).toHaveText("23", {
    timeout: 15000,
  });
  const first = player
    .locator(".anime-episodes")
    .getByRole("button", { name: "1", exact: true });
  await first.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await first.click();
  await expect(player.locator(".anime-episode-number")).toHaveText("1");
  await player.scrollIntoViewIfNeeded();
  const getPlayer = () =>
    app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((item) =>
          item.getURL().startsWith("https://player.bilibili.com/"),
        )
        .map((item) => item.id),
    );
  await expect
    .poll(async () => (await getPlayer()).length, { timeout: 15000 })
    .toBe(1);
  const playerContents = (await getPlayer())[0];
  const inspectPlayer = (source) =>
    app.evaluate(
      ({ webContents }, input) =>
        webContents.fromId(input.id).executeJavaScript(input.source, true),
      { id: playerContents, source },
    );
  await expect
    .poll(() => inspectPlayer("!!document.querySelector('video')"), {
      timeout: 20000,
    })
    .toBe(true);
  await (
    await app.browserWindow(page)
  ).evaluate((window) => {
    window.show();
    window.focus();
  });
  await inspectPlayer(
    "(()=>{const v=document.querySelector('video');v.muted=true;if(v.paused){const button=document.querySelector('[aria-label=\"播放/暂停\"]');if(button)button.click();else void v.play();}return true})()",
  );
  await expect
    .poll(() => inspectPlayer("document.querySelector('video').currentTime"), {
      timeout: 20000,
    })
    .toBeGreaterThan(8);
  const playback = await inspectPlayer(
    "(()=>{const v=document.querySelector('video');return {currentTime:v.currentTime,duration:v.duration,width:v.videoWidth,height:v.videoHeight,paused:v.paused}})()",
  );
  await page.screenshot({ path: join(artifacts, "light.png") });
  const playerImage = await app.evaluate(
    async ({ webContents }, id) =>
      (await webContents.fromId(id).capturePage()).toPNG().toString("base64"),
    playerContents,
  );
  await writeFile(
    join(artifacts, "player.png"),
    Buffer.from(playerImage, "base64"),
  );
  const colorMode = async (mode) => {
    await page.getByLabel("账户菜单", { exact: true }).click();
    await page.getByRole("menuitem", { name: "外观", exact: true }).hover();
    await page.getByRole("menuitem", { name: "明暗模式", exact: true }).hover();
    await page
      .getByText(mode === "dark" ? "深色" : "浅色", { exact: true })
      .last()
      .click();
    await expect
      .poll(() =>
        player.evaluate((element) =>
          element.closest(".mu-scope")?.getAttribute("data-theme"),
        ),
      )
      .toBe(mode);
  };
  await colorMode("dark");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(artifacts, "dark.png") });
  await (
    await app.browserWindow(page)
  ).evaluate((window) => window.setSize(900, 820));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(artifacts, "narrow.png") });
  await expect(player).toBeVisible();
  const overflows = await player.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  if (overflows) throw new Error("Player overflows at narrow window width");
  await (
    await app.browserWindow(page)
  ).evaluate((window) => window.setSize(1400, 940));
  await colorMode("light");
  await player.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(artifacts, "preview.png") });
  await page.evaluate(() => {
    document.title = "Yomni Bilibili Plugin Preview";
  });
  if (messages.length !== requestCount)
    throw new Error("UI navigation unexpectedly called the model");
  await writeFile(
    join(artifacts, "preview.json"),
    JSON.stringify(
      {
        data,
        host,
        errors,
        requests: messages.length,
        debugPort: 9867,
        playback,
        checks: [
          "real-search",
          "season-switch",
          "episode-select",
          "previous-next",
          "reload-restores-selection",
          "real-playback",
          "light",
          "dark",
          "narrow-no-overflow",
          "ui-does-not-call-model",
        ],
      },
      null,
      2,
    ),
  );
  console.log(`PREVIEW_READY ${artifacts}`);
  if (process.argv.includes("--preview")) {
    keepOpen = true;
    await new Promise(() => {});
  }
} catch (error) {
  if (app) {
    try {
      const diagnostics = await app.evaluate(async ({ webContents }) => {
        const pages = webContents.getAllWebContents();
        return Promise.all(
          pages.map(async (item) => ({
            id: item.id,
            url: item.getURL(),
            ...(item.getURL().startsWith("https://player.bilibili.com/")
              ? {
                  video: await item.executeJavaScript(
                    "(()=>{const v=document.querySelector('video');return v?{time:v.currentTime,duration:v.duration,paused:v.paused,readyState:v.readyState,width:v.videoWidth,error:v.error?.message,visibility:document.visibilityState}:null})()",
                  ),
                }
              : {}),
          })),
        );
      });
      await writeFile(
        join(artifacts, "player-diagnostics.json"),
        JSON.stringify(diagnostics, null, 2),
      );
      const pages = app
        .windows()
        .filter((item) => !item.isClosed() && !item.url().includes("#account"));
      if (pages[0])
        await pages[0].screenshot({ path: join(artifacts, "failure.png") });
    } catch {}
  }
  await writeFile(
    join(artifacts, "failure.json"),
    JSON.stringify(
      { error: String(error), errors, stderr, requests: messages },
      null,
      2,
    ),
  );
  console.error(error);
  throw error;
} finally {
  if (!keepOpen && app) {
    const timeout = setTimeout(() => app.process().kill(), 5000);
    try {
      await app.close();
    } finally {
      clearTimeout(timeout);
    }
  }
  await writeFile(join(artifacts, "stderr.log"), stderr.join(""));
  server.close();
}
