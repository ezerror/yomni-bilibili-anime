export interface Episode {
  id: string;
  title: string;
  name: string;
  bvid: string;
  aid?: number;
  cid?: number;
  epId?: number;
  badge: string;
}

export interface Season {
  id: number;
  title: string;
  cover: string;
  description: string;
  status: string;
  url: string;
  episodes: Episode[];
  episodesUnavailable?: boolean;
}

export interface PlayerCard {
  id: string;
  keyword: string;
  seasons: Season[];
  seasonId?: number;
  episodeId?: string;
  error?: "search-failed";
}

export function selectedEpisode(card: PlayerCard) {
  const season =
    card.seasons.find((item) => item.id === card.seasonId) ?? card.seasons[0];
  const episode =
    season?.episodes.find((item) => item.id === card.episodeId) ??
    season?.episodes[0];
  return { season, episode };
}

export function playerUrl(episode: Episode): string {
  const query = new URLSearchParams({
    isOutside: "true",
    bvid: episode.bvid,
    autoplay: "0",
    high_quality: "1",
  });
  if (episode.aid) query.set("aid", String(episode.aid));
  if (episode.cid) query.set("cid", String(episode.cid));
  return `https://player.bilibili.com/player.html?${query}`;
}

export function playerDirective(id: string): string {
  return `bilibili-anime${JSON.stringify({ id })}`;
}
