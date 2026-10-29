import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  parseEpisodes,
  parseSeasons,
  BilibiliClient,
} from "../src/bilibili.ts";
import { PlayerStore } from "../src/store.ts";
import { playerUrl } from "../src/types.ts";

test("search metadata is plain text and missing season IDs are excluded", () => {
  const seasons = parseSeasons([
    {
      season_id: 46089,
      title: '<em class="keyword">葬送</em>的芙莉莲 &amp; Friends',
      cover: "//i0.hdslb.com/cover.jpg",
    },
    { title: "invalid" },
  ]);
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0].title, "葬送的芙莉莲 & Friends");
  assert.equal(seasons[0].cover, "https://i0.hdslb.com/cover.jpg");
});

test("episode sections deduplicate identities while preserving different parts of one video", () => {
  const episodes = parseEpisodes({
    episodes: [
      { id: 1, bvid: "BV12345", cid: 10, title: "1" },
      { id: 9, bvid: "BVTRAILER", title: "2", badge: "预告" },
      { id: 2, bvid: "BV12345", cid: 20, title: "2" },
    ],
    section: [
      {
        title: "正片",
        episodes: [
          { id: 1, bvid: "BV12345", cid: 10 },
          { id: 3, bvid: "BV67890", title: "OP" },
        ],
      },
      { title: "PV预告", episodes: [{ id: 4, bvid: "BV99999" }] },
    ],
  });
  assert.deepEqual(
    episodes.map((item) => item.id),
    ["1", "2", "3"],
  );
  const url = new URL(playerUrl(episodes[1]));
  assert.equal(url.hostname, "player.bilibili.com");
  assert.equal(url.searchParams.get("cid"), "20");
  assert.equal(url.searchParams.get("autoplay"), "0");
});

test("one unavailable season does not discard other playable results", async () => {
  const client = new BilibiliClient(async (url) => {
    if (url.includes("search/type"))
      return Response.json({
        code: 0,
        data: {
          result: [
            { season_id: 1, title: "One" },
            { season_id: 2, title: "Two" },
          ],
        },
      });
    if (url.endsWith("=2")) return Response.json({ code: -404 });
    return Response.json({
      code: 0,
      result: { episodes: [{ id: 42, title: "1", bvid: "BV12345" }] },
    });
  });
  const seasons = await client.search(
    "Frieren",
    5,
    new AbortController().signal,
  );
  assert.equal(seasons[0].episodes.length, 1);
  assert.equal(seasons[1].episodesUnavailable, true);
});

test("player cards persist independently across conversations and store instances", async () => {
  const artifacts = join(import.meta.dirname, "../artifacts");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "unit-"));
  try {
    const store = new PlayerStore(directory);
    await store.write("conversation-a", {
      id: "library",
      keyword: "Frieren",
      seasons: [],
      episodeId: "23",
    });
    await store.write("conversation-b", {
      id: "library",
      keyword: "Another title",
      seasons: [],
    });
    const restored = new PlayerStore(directory);
    assert.equal(
      (await restored.read("conversation-a", "library")).episodeId,
      "23",
    );
    assert.equal(
      (await restored.read("conversation-b", "library")).keyword,
      "Another title",
    );
    await assert.rejects(() => restored.read("conversation-a", "../escape"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
