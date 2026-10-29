import { randomUUID } from "node:crypto";
import type {
  PluginModule,
  PluginUiRequest,
  ToolContext,
  ToolDefinition,
} from "@anypal/contracts";
import manifest from "../pal-manifest.json";
import { BilibiliClient } from "./bilibili";
import { PlayerStore } from "./store";
import { playerDirective, selectedEpisode, type PlayerCard } from "./types";

const uiId = "pal.bilibili-anime.player";
const scope = (context: ToolContext) =>
  JSON.stringify([context.projectId ?? "", context.sessionId ?? ""]);
const cardId = (request: PluginUiRequest): string =>
  request.resource ? String(JSON.parse(request.resource).id) : "library";

export const activate: PluginModule["activate"] = async (host) => {
  const store = new PlayerStore(host.storagePath);
  const client = new BilibiliClient();
  const search = async (
    keyword: string,
    limit: number,
    id: string,
    context: ToolContext,
  ) => {
    keyword = keyword.trim().slice(0, 120);
    if (!keyword) throw new Error("Enter an anime title");
    const seasons = await client.search(keyword, limit, context.signal);
    const card: PlayerCard = {
      id,
      keyword,
      seasons,
      seasonId: seasons[0]?.id,
      episodeId: seasons[0]?.episodes[0]?.id,
    };
    context.signal.throwIfAborted();
    await store.write(scope(context), card);
    host.invalidateUi?.();
    return card;
  };
  return {
    ui: [
      {
        id: uiId,
        slot: "pal.ui.panel",
        hostRenderer: "anime",
        messagePresentation: true,
        contentDirective: "bilibili-anime",
        nativeCapabilities: ["web-preview"],
        persistentSession: true,
        requiredPermissions: [
          "pal.network.fetch",
          "pal.browser.control",
          "pal.storage.read",
          "pal.storage.write",
        ],
        actions: ["search", "select"],
        actionLimits: { maxValueChars: 4000, timeoutMs: 45000 },
        launcher: {
          title: "Bilibili Anime",
          icon: "globe",
          description: "Search and watch anime",
          locales: {
            "zh-CN": {
              title: "哔哩哔哩番剧",
              description: "搜索番剧与分集播放",
            },
          },
        },
        async render(request, context) {
          return {
            title: "Bilibili Anime",
            children: [],
            data: await store.read(scope(context), cardId(request)),
          };
        },
        async act(action, context, request) {
          const id = cardId(request);
          if (action.id === "search") {
            try {
              await search(action.value ?? "", 5, id, context);
            } catch (error) {
              context.signal.throwIfAborted();
              console.warn("[bilibili-anime] Search failed", error);
              const previous = await store.read(scope(context), id);
              await store.write(scope(context), {
                ...previous,
                error: "search-failed",
              });
            }
            return;
          }
          const card = await store.read(scope(context), id);
          const input = JSON.parse(action.value ?? "{}") as {
            seasonId?: number;
            episodeId?: string;
          };
          const season = card.seasons.find(
            (item) => item.id === input.seasonId,
          );
          if (!season) throw new Error("Choose an available season");
          const episode =
            season.episodes.find((item) => item.id === input.episodeId) ??
            season.episodes[0];
          await store.write(scope(context), {
            ...card,
            error: undefined,
            seasonId: season.id,
            episodeId: episode?.id,
          });
        },
      },
    ],
    tools: [
      {
        definition: manifest.tools[0] as ToolDefinition,
        isAvailable: (context) => !!context.sessionId,
        async execute(input, context) {
          const value = input as { keyword: string; max_seasons?: number };
          const card = await search(
            value.keyword,
            Math.max(1, Math.min(8, value.max_seasons ?? 5)),
            randomUUID(),
            context,
          );
          const { season } = selectedEpisode(card);
          return {
            keyword: card.keyword,
            count: card.seasons.length,
            results: card.seasons.map((item) => ({
              title: item.title,
              episodes: item.episodes.length,
            })),
            selected: season?.title,
            directive: playerDirective(card.id),
          };
        },
      },
    ],
  };
};
