import React, { useEffect, useRef, useState } from "react";
import { Button, IconButton, Input, Tooltip, UiProvider } from "@yomni/ui";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Search,
  Monitor,
} from "@yomni/ui/icons";
import type {
  PluginFrontendApi,
  PluginSurfaceSnapshot,
} from "@yomni/contracts";
import { isServiceCancellation } from "./errors";
import { playerUrl, selectedEpisode, type PlayerCard } from "../src/types";
// @ts-expect-error The plugin builder embeds styles in the host ShadowRoot.
import uiCss from "@yomni/ui/styles.css";
// @ts-expect-error Text CSS imports retain the public tooltip's isolated styles.
import tooltipCss from "@yomni/ui/tooltip.css";
// @ts-expect-error The plugin builder bundles stylesheet imports as text.
import css from "./style.css";

const translations = {
  en: {
    search: "Search anime",
    placeholder: "Anime title",
    searchButton: "Search",
    previous: "Previous episode",
    next: "Next episode",
    external: "Open in browser",
    retry: "Reload player",
    empty: "Search for an anime to start watching.",
    noResults: "No anime found. Try another title.",
    searchError: "Search could not be completed. Try again.",
    actionError: "The selection could not be saved. Try again.",
    playerError:
      "The player could not be loaded. Reload it or open it in your browser.",
    noEpisodes: "No playable episodes are available for this season.",
    season: "Seasons",
    episodes: "Episodes",
    searching: "Searching…",
    loading: "Loading player…",
  },
  zh: {
    search: "搜索番剧",
    placeholder: "番剧名称",
    searchButton: "搜索",
    previous: "上一集",
    next: "下一集",
    external: "在浏览器中打开",
    retry: "重新加载播放器",
    empty: "搜索一部番剧，开始观看。",
    noResults: "没有找到番剧，请换个名称搜索。",
    searchError: "搜索未完成，请重试。",
    actionError: "选集未能保存，请重试。",
    playerError: "播放器未能加载，请重新加载或在浏览器中打开。",
    noEpisodes: "这部番剧暂时没有可播放的分集。",
    season: "番剧",
    episodes: "选集",
    searching: "搜索中…",
    loading: "正在加载播放器…",
  },
};

interface Props {
  api: Pick<PluginFrontendApi, "action" | "webPreview">;
  snapshot: PluginSurfaceSnapshot;
  active: boolean;
  overlayRoot?: HTMLElement;
}

function AnimePlayer({ api, snapshot, active }: Props) {
  const t = snapshot.locale.startsWith("zh")
    ? translations.zh
    : translations.en;
  const [card, setCard] = useState(snapshot.view.data as PlayerCard);
  const [query, setQuery] = useState(card.keyword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [playerError, setPlayerError] = useState(false);
  const [loading, setLoading] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const navigation = useRef(Promise.resolve());
  const lifetime = useRef({ active: false });
  const currentUrl = useRef("");
  const { season, episode } = selectedEpisode(card);
  const url = episode ? playerUrl(episode) : "";
  const index =
    season?.episodes.findIndex((item) => item.id === episode?.id) ?? -1;

  useEffect(() => {
    const current = { active };
    lifetime.current = current;
    setBusy(false);
    return () => {
      current.active = false;
    };
  }, [api, active]);

  useEffect(() => {
    const next = snapshot.view.data as PlayerCard;
    setCard(next);
    setQuery(next.keyword);
  }, [snapshot.view.data]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const stop = api.webPreview.onChanged((state) => {
      if (disposed) return;
      setLoading(state.loading);
      setPlayerError(!!state.error);
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [api, active]);

  useEffect(() => {
    if (!url || !active) {
      currentUrl.current = "";
      return;
    }
    if (currentUrl.current === url) return;
    let disposed = false;
    currentUrl.current = url;
    setLoading(true);
    setPlayerError(false);
    navigation.current = navigation.current
      .catch(() => {})
      .then(async () => {
        if (disposed || currentUrl.current !== url) return;
        try {
          await api.webPreview.command({ type: "navigate", url });
        } catch (error) {
          if (
            !disposed &&
            !isServiceCancellation(error) &&
            currentUrl.current === url
          ) {
            setPlayerError(true);
            setLoading(false);
          }
        }
      });
    return () => {
      disposed = true;
      currentUrl.current = "";
    };
  }, [api, active, url]);

  useEffect(() => {
    if (!viewport.current || !panel.current) return;
    let frame = 0,
      disposed = false,
      lastBounds = "";
    const layout = () => {
      frame = 0;
      if (disposed || !viewport.current || !panel.current) return;
      const box = viewport.current.getBoundingClientRect();
      const host = panel.current.getRootNode() as ShadowRoot;
      const base =
        host.host?.getBoundingClientRect() ??
        panel.current.getBoundingClientRect();
      const bounds = {
        x: box.x - base.x,
        y: box.y - base.y,
        width: box.width,
        height: box.height,
        visible: active && !!url && box.width > 0 && box.height > 0,
      };
      // A changed absolute position must be relayed even when local bounds stay equal.
      const signature = JSON.stringify([bounds, base.x, base.y]);
      if (lastBounds === signature) return;
      lastBounds = signature;
      void api.webPreview.layout(bounds).catch((error) => {
        if (active && !disposed && !isServiceCancellation(error))
          setPlayerError(true);
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(layout);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport.current);
    resize.observe(panel.current);
    const intersection = new IntersectionObserver(schedule);
    intersection.observe(viewport.current);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      void api.webPreview
        .layout({ x: 0, y: 0, width: 0, height: 0, visible: false })
        .catch(() => {});
    };
  }, [api, active, url]);

  async function act(action: string, value: string) {
    const current = lifetime.current;
    if (busy || !current.active) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.action(action, value);
      if (current.active) setCard(next.view.data as PlayerCard);
    } catch (error) {
      if (current.active && !isServiceCancellation(error))
        setError(action === "search" ? t.searchError : t.actionError);
    } finally {
      if (current.active) setBusy(false);
    }
  }

  function playerCommand(
    command: Parameters<Props["api"]["webPreview"]["command"]>[0],
  ) {
    const current = lifetime.current;
    if (!current.active) return;
    void api.webPreview.command(command).catch((error) => {
      if (current.active && !isServiceCancellation(error)) setPlayerError(true);
    });
  }

  function select(seasonId: number, episodeId?: string) {
    void act("select", JSON.stringify({ seasonId, episodeId }));
  }

  const iconAction = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled = false,
  ) => (
    <Tooltip content={label}>
      <IconButton
        size="icon"
        variant="quiet"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );

  return (
    <div className="anime-player" ref={panel} data-testid="anime-player">
      <form
        className="anime-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) void act("search", query);
        }}
      >
        <Input
          label={t.search}
          hideLabel
          placeholder={t.placeholder}
          value={query}
          onChange={setQuery}
          leftIcon={<Search size={14} />}
          disabled={busy}
        />
        <Button
          size="small"
          variant="outline"
          type="submit"
          disabled={busy || !query.trim()}
          loading={busy}
        >
          {busy ? t.searching : t.searchButton}
        </Button>
      </form>
      {(error || card.error) && (
        <div className="anime-error" role="alert">
          {error || t.searchError}
        </div>
      )}
      {!!card.seasons.length && (
        <div className="anime-seasons" role="group" aria-label={t.season}>
          {card.seasons.map((item) => (
            <Button
              key={item.id}
              size="small"
              variant="quiet"
              aria-pressed={item.id === season?.id}
              disabled={busy}
              onClick={() => select(item.id)}
            >
              {item.title}
            </Button>
          ))}
        </div>
      )}
      {season ? (
        <>
          <div className="anime-heading">
            <strong>{season.title}</strong>
            <span>{season.status}</span>
          </div>
          {episode ? (
            <div
              ref={viewport}
              className="anime-viewport"
              aria-label={episode.name || episode.title}
            >
              <div className="anime-placeholder">
                <Monitor size={22} />
                <span>{loading ? t.loading : season.title}</span>
              </div>
            </div>
          ) : (
            <div className="anime-empty">
              <Monitor size={24} />
              <span>{t.noEpisodes}</span>
            </div>
          )}
          {playerError && (
            <div className="anime-error" role="alert">
              {t.playerError}
            </div>
          )}
          {!!episode && (
            <div className="anime-controls">
              <div className="anime-episode-heading">
                <span className="anime-episode-number">{episode.title}</span>
                <span>{episode.name}</span>
              </div>
              <div className="anime-actions">
                {iconAction(
                  t.previous,
                  <ChevronLeft size={15} />,
                  () => select(season.id, season.episodes[index - 1]?.id),
                  busy || index <= 0,
                )}
                {iconAction(
                  t.next,
                  <ChevronRight size={15} />,
                  () => select(season.id, season.episodes[index + 1]?.id),
                  busy || index >= season.episodes.length - 1,
                )}
                <span className="anime-divider" />
                {iconAction(t.retry, <RefreshCw size={14} />, () => {
                  setPlayerError(false);
                  playerCommand({ type: "reload" });
                })}
                {iconAction(t.external, <ExternalLink size={14} />, () => {
                  void api.webPreview
                    .command({ type: "external" })
                    .catch(() => setPlayerError(true));
                })}
              </div>
            </div>
          )}
          {!!season.episodes.length && (
            <div
              className="anime-episodes"
              role="group"
              aria-label={t.episodes}
            >
              {season.episodes.map((item) => (
                <Tooltip
                  key={item.id}
                  content={[item.title, item.name, item.badge]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <Button
                    size="small"
                    variant="quiet"
                    aria-pressed={item.id === episode?.id}
                    disabled={busy}
                    onClick={() => select(season.id, item.id)}
                  >
                    {item.title}
                  </Button>
                </Tooltip>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="anime-empty">
          <Monitor size={24} />
          <span>{card.keyword ? t.noResults : t.empty}</span>
        </div>
      )}
    </div>
  );
}

export default function AnimePanel(props: Props) {
  const theme = props.snapshot.theme;
  const variables = Object.fromEntries(
    Object.entries(theme?.colors ?? {}).map(([key, value]) => [
      `--yomni-${key}`,
      value,
    ]),
  );
  return (
    <>
      <style>{uiCss + tooltipCss + css}</style>
      <UiProvider
        density="compact"
        theme={theme?.mode}
        locale={props.snapshot.locale.startsWith("zh") ? "zh-CN" : "en"}
        portalContainer={props.overlayRoot}
        inheritTheme
        style={
          {
            ...variables,
            "--yomni-accent": theme?.accent,
            fontFamily: "inherit",
          } as React.CSSProperties
        }
      >
        <AnimePlayer {...props} />
      </UiProvider>
    </>
  );
}
