import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toolAuthorizationFingerprint } from "@yomni/plugin-sdk/tool-provider";
import {
  TOOL_AUTHORIZATIONS_CONTRACT,
  TOOL_AUTHORIZATION_PERMISSION,
} from "@yomni/contracts/tool-provider";
import { isServiceCancellation } from "../ui/errors.ts";

const require = createRequire(import.meta.url);
const declaration = JSON.parse(
  await readFile(new URL("../pal-manifest.json", import.meta.url), "utf8"),
);
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const manifest = {
  ...declaration,
  id: pkg.pal.id,
  name: declaration.title,
  version: pkg.version,
  apiVersion: 1,
  main: "dist/index.cjs",
};
const value = {
  projectId: "project-a",
  sessionId: "session-a",
  runId: "run-a",
  toolCallId: "tool-a",
};
const tool = "bilibili_search_anime";

async function fixture(t, storagePath) {
  if (!storagePath) {
    const artifacts = resolve(import.meta.dirname, "../artifacts");
    await mkdir(artifacts, { recursive: true });
    storagePath = await mkdtemp(join(artifacts, "service-unit-"));
    assert.ok(storagePath.startsWith(artifacts));
    t.after(() => rm(storagePath, { recursive: true, force: true }));
  }
  const owner = new AbortController();
  const caller = new AbortController();
  const revoked = new AbortController();
  const finalizers = [],
    disposers = [],
    invalidations = [];
  const tokens = new Map();
  const grants = [...manifest.permissions];
  const lifetime = {
    signal: owner.signal,
    revokedSignal: revoked.signal,
    phase: "active",
    generation: Symbol("test-generation"),
    finalize(callback) {
      finalizers.push(callback);
      return () => {};
    },
    defer(callback) {
      disposers.push(callback);
      return () => {};
    },
  };
  const host = {
    pluginId: manifest.id,
    storagePath,
    signal: owner.signal,
    lifetime,
    grantedPermissions: new Set(grants),
    catalog: { list: () => [{ manifest }], revision: 1 },
    withCallPolicy: (_policy, operation) => operation(),
    invalidateUi: (sessionId) => invalidations.push(sessionId),
    selectService: async (alias, binding) => {
      assert.equal(alias, "toolAuthorizations");
      assert.equal(binding.provider, "example.tool-owner");
      return {
        call: async (method, claim) => {
          assert.equal(method, "claim");
          assert.equal(
            tokens.get(claim.authorization),
            toolAuthorizationFingerprint(claim),
          );
          assert.ok(tokens.delete(claim.authorization));
          return {
            permissionBudget: grants,
            readOnly: false,
            signal: caller.signal,
          };
        },
      };
    },
  };
  // The host loads a fresh module for every plugin generation.
  delete require.cache[require.resolve("../dist/index.cjs")];
  const { activate } = require("../dist/index.cjs");
  const contributions = await activate(host);
  const authority = {
    pluginId: "example.tool-owner",
    manifest: {
      provides: {
        "example.tool-owner.authorizations": TOOL_AUTHORIZATIONS_CONTRACT,
      },
    },
    grantedPermissions: [...grants, TOOL_AUTHORIZATION_PERMISSION],
    permissionBudget: grants,
    signal: caller.signal,
    available: () => !caller.signal.aborted,
  };
  const callContext = {
    caller: authority.pluginId,
    callerAuthority: authority,
    signal: caller.signal,
    ownerSignal: caller.signal,
    depth: 1,
    projectId: value.projectId,
    sessionId: value.sessionId,
  };
  const provider = contributions.services[`${manifest.id}.tools`];
  const catalog = await provider.methods.catalog.call(
    { context: value },
    callContext,
  );
  async function call(name, input, operationInput = input.input) {
    const authorization = randomUUID();
    const claim = {
      tool,
      context: value,
      revision: catalog.revision,
      phase: name,
      ...(operationInput === undefined ? {} : { input: operationInput }),
      ...(input.preparedId ? { preparedId: input.preparedId } : {}),
    };
    tokens.set(authorization, toolAuthorizationFingerprint(claim));
    return provider.methods[name].call(
      {
        tool,
        context: value,
        revision: catalog.revision,
        ...input,
        authorization,
      },
      callContext,
    );
  }
  const execute = async (input) => {
    const prepared = await call("prepare", { input, lifetime: caller.signal });
    return call("execute", { preparedId: prepared.id }, prepared.input);
  };
  t.after(async () => {
    owner.abort(new DOMException("Test activation closed", "AbortError"));
    for (const callback of finalizers) await callback();
    for (const callback of disposers.reverse()) await callback();
    revoked.abort();
  });
  return {
    host,
    owner,
    contributions,
    provider,
    catalog,
    execute,
    callContext,
    storagePath,
    invalidations,
  };
}

function mockBilibili(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    if (String(url).includes("search/type"))
      return Response.json({
        code: 0,
        data: {
          result: [
            { season_id: 1, title: "First season" },
            { season_id: 2, title: "Second season" },
          ],
        },
      });
    const seasonId = new URL(url).searchParams.get("season_id");
    return Response.json({
      code: 0,
      result: {
        episodes: [
          {
            id: Number(seasonId) * 10 + 1,
            title: "1",
            bvid: `BV${seasonId}1`,
            cid: 11,
          },
          {
            id: Number(seasonId) * 10 + 2,
            title: "2",
            bvid: `BV${seasonId}2`,
            cid: 12,
          },
        ],
      },
    });
  });
  return requests;
}

const uiRequest = (resource) => ({
  id: "pal.bilibili-anime.player",
  locale: "en",
  projectId: value.projectId,
  sessionId: value.sessionId,
  resource,
});
const uiContext = () => ({ ...value, signal: new AbortController().signal });

test("current build publishes declared tool and prompt services with conversation availability", async (t) => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn(declaration, "activationScope"), false);
  assert.equal(f.contributions.tools, undefined);
  assert.deepEqual(
    Object.keys(f.contributions.services).sort(),
    Object.keys(manifest.provides).sort(),
  );
  assert.deepEqual(
    f.catalog.definitions.map((item) => item.id),
    [tool],
  );
  const unbound = { ...value, sessionId: "" };
  const empty = await f.provider.methods.catalog.call(
    { context: unbound },
    { ...f.callContext, sessionId: undefined },
  );
  assert.deepEqual(empty.definitions, []);
  await assert.rejects(
    () =>
      f.provider.methods.catalog.call(
        {},
        { ...f.callContext, callerAuthority: undefined },
      ),
    /available calling plugin/,
  );
  const prompts =
    f.contributions.services[`${manifest.id}.agent-support.prompts`];
  const catalog = await prompts.methods.catalog.call({}, f.callContext);
  assert.equal(catalog.declarations[0].id, "bilibili-player");
  const prompt = await prompts.methods.provide.call(
    { id: "bilibili-player", request: value },
    f.callContext,
  );
  assert.match(prompt, /bilibili_search_anime/);
  const panel = f.contributions.ui[0];
  assert.equal(panel.messagePresentation, true);
  assert.equal(panel.contentDirective, "bilibili-anime");
  assert.equal(panel.persistentSession, true);
  assert.deepEqual(panel.nativeCapabilities, ["web-preview"]);
});

test("authorized service execution creates an isolated player; UI selection persists without another model or network request", async (t) => {
  const requests = mockBilibili(t);
  const f = await fixture(t);
  const result = await f.execute({ keyword: "Frieren", max_seasons: 2 });
  assert.equal(result.count, 2);
  assert.equal(requests.length, 3);
  assert.match(result.directive, /^:::yomni:bilibili-anime \{"id":"[a-f0-9-]+"\}$/);
  const reference = result.directive.slice(":::yomni:bilibili-anime ".length);
  const request = uiRequest(reference);
  const panel = f.contributions.ui[0];
  const first = await panel.render(request, uiContext());
  assert.equal(first.data.keyword, "Frieren");
  assert.equal(first.data.seasonId, 1);
  await panel.act(
    { id: "select", value: JSON.stringify({ seasonId: 2, episodeId: "22" }) },
    uiContext(),
    request,
  );
  assert.equal(requests.length, 3);
  const restored = await fixture(t, f.storagePath);
  const next = await restored.contributions.ui[0].render(request, uiContext());
  assert.equal(next.data.seasonId, 2);
  assert.equal(next.data.episodeId, "22");
  assert.deepEqual(f.invalidations, [value.sessionId]);
  await assert.rejects(
    () => panel.render(request, { ...uiContext(), sessionId: "session-b" }),
    { code: "ENOENT" },
  );
  const library = await panel.render(uiRequest(undefined), uiContext());
  assert.deepEqual(library.data.seasons, []);
});

test("cancelled search preserves the previous card and does not become a search failure", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  t.mock.method(
    globalThis,
    "fetch",
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
        entered();
      }),
  );
  const f = await fixture(t);
  const panel = f.contributions.ui[0];
  const controller = new AbortController();
  const pending = panel.act(
    { id: "search", value: "cancelled" },
    { ...value, signal: controller.signal },
    uiRequest(undefined),
  );
  await started;
  controller.abort(new DOMException("View closed", "AbortError"));
  await assert.rejects(() => pending, { name: "AbortError" });
  const card = await panel.render(uiRequest(undefined), uiContext());
  assert.equal(card.data.keyword, "");
  assert.equal(card.data.error, undefined);
  assert.deepEqual(f.invalidations, []);
});

test("activation revocation cancels a pending tool without publishing or saving partial data", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  t.mock.method(
    globalThis,
    "fetch",
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
        entered();
      }),
  );
  const f = await fixture(t);
  const pending = f.execute({ keyword: "pending" });
  await started;
  f.owner.abort(new DOMException("Plugin disabled", "AbortError"));
  await assert.rejects(() => pending, { name: "AbortError" });
  assert.deepEqual(f.invalidations, []);
});

test("UI cancellation classification keeps active provider and network faults visible", () => {
  assert.equal(
    isServiceCancellation(new DOMException("closed", "AbortError")),
    true,
  );
  assert.equal(
    isServiceCancellation({ name: "RemoteHostError", code: "CANCELLED" }),
    true,
  );
  assert.equal(
    isServiceCancellation({ code: "UNAVAILABLE", message: "provider offline" }),
    false,
  );
  assert.equal(isServiceCancellation(new Error("request failed")), false);
});
