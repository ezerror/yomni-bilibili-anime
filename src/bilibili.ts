import type { Episode, Season } from "./types";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" ? (value as RecordValue) : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const number = (value: unknown): number | undefined =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : undefined;

export function plainText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function parseSeasons(value: unknown): Season[] {
  return array(value).flatMap((raw) => {
    const item = object(raw),
      id = number(item.season_id);
    if (!id) return [];
    const cover = String(item.cover ?? "");
    return [
      {
        id,
        title: plainText(item.title),
        cover: cover.startsWith("//")
          ? `https:${cover}`
          : /^https?:/.test(cover)
            ? cover
            : "",
        description: plainText(item.desc ?? item.evaluate),
        status: plainText(item.index_show),
        url: `https://www.bilibili.com/bangumi/play/ss${id}`,
        episodes: [],
      },
    ];
  });
}

export function parseEpisodes(value: unknown): Episode[] {
  const result = object(value);
  const sections = array(result.section).filter(
    (raw) => !/PV|预告/i.test(String(object(raw).title ?? "")),
  );
  const episodes = [
    ...array(result.episodes),
    ...sections.flatMap((raw) => array(object(raw).episodes)),
  ];
  const seen = new Set<string>();
  return episodes.flatMap((raw) => {
    const item = object(raw),
      bvid = String(item.bvid ?? "");
    if (
      !/^BV[\w]+$/.test(bvid) ||
      /预告|trailer|\bPV\b/i.test(String(item.badge ?? ""))
    )
      return [];
    const epId = number(item.id),
      cid = number(item.cid);
    const id = String(epId ?? `${bvid}:${cid ?? ""}`);
    const identity = `${bvid}:${cid ?? ""}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [
      {
        id,
        title: plainText(item.title) || String(seen.size),
        name: plainText(item.long_title),
        bvid,
        ...(number(item.aid) ? { aid: number(item.aid) } : {}),
        ...(cid ? { cid } : {}),
        ...(epId ? { epId } : {}),
        badge: plainText(item.badge),
      },
    ];
  });
}

export class BilibiliClient {
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch) {
    this.request = request;
  }

  private async get(path: string, signal: AbortSignal) {
    const response = await this.request(`https://api.bilibili.com${path}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        Referer: "https://www.bilibili.com/",
        Origin: "https://www.bilibili.com",
        Accept: "application/json",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
    const payload = object(await response.json());
    if (Number(payload.code ?? 0) !== 0)
      throw new Error(`Bilibili API ${payload.code}`);
    return object(payload.result ?? payload.data);
  }

  async search(
    keyword: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Season[]> {
    const query = new URLSearchParams({
      search_type: "media_bangumi",
      keyword,
      page: "1",
    });
    const data = await this.get(
      `/x/web-interface/wbi/search/type?${query}`,
      signal,
    );
    const seasons = parseSeasons(data.result).slice(0, limit);
    await Promise.all(
      seasons.map(async (season) => {
        try {
          season.episodes = parseEpisodes(
            await this.get(
              `/pgc/view/web/season?season_id=${season.id}`,
              signal,
            ),
          );
        } catch (error) {
          signal.throwIfAborted();
          console.warn(
            "[bilibili-anime] Episode lookup failed",
            season.id,
            error,
          );
          season.episodesUnavailable = true;
        }
      }),
    );
    return seasons;
  }
}
