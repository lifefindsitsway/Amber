import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button.tsx";
import { BilibiliPlayer } from "./bilibili-player.tsx";
import type { PlayerSource } from "./capabilities.ts";
import type { AdvanceResult, LoopCollectionChoice } from "./list-loop.ts";
import { LocalPlayer } from "./local-player.tsx";
import type { QualitySource } from "./player-menus.tsx";
import type { ChapterEntry } from "./seek-bar.tsx";
import type { SubtitleTrackModel } from "./subtitle-overlay.tsx";
import { YoutubePlayer } from "./youtube-player.tsx";

/** Which player is on screen: the platform iframe, the `<video>` player, or neither. */
export type ActivePlayer = "iframe" | "local" | "none";

/**
 * Picks the player for a source and handles iframe failure: a platform video
 * plays in its iframe, or in the `<video>` player when the user switched to its cached copy
 * (`preferLocal`); when the iframe fails, a cached copy (`localSrc`) plays instead,
 * otherwise the user can cache it (`onCache`, desktop client only) or open the original
 * page. A local file plays only when a media URL is available; `localHint` says why not.
 * `localAudioOnly` marks a `localSrc` without a picture (an audio-only cache).
 * `onActiveChange` reports the player actually shown; a new `onlineAttempt` forgets an
 * iframe failure so the user can try the platform again. `renderBelow` draws what goes
 * under the player for the player computed in this very render, so switching players never
 * shows one frame of the other's strip. `chapters`, `autoplay`, `onEndedAdvance` and
 * `loopCollection` go to the `<video>` player, and so do `subtitles`; a platform iframe cannot
 * carry them, so while subtitles are wanted there it says where they can be seen.
 * `localSources`, `localSourceId` and `onSelectLocalSource` are the cached qualities of the
 * file `localSrc` plays; the page gives them only while a video cache plays, and they never
 * reach an audio-only file.
 */
export function PlayerView(props: {
  source: PlayerSource;
  localSrc?: string;
  localAudioOnly?: boolean;
  preferLocal?: boolean;
  onCache?: () => void;
  localHint?: string;
  onlineAttempt?: number;
  onActiveChange?: (active: ActivePlayer) => void;
  renderBelow?: (active: ActivePlayer) => ReactNode;
  chapters?: readonly ChapterEntry[];
  autoplay?: boolean;
  onEndedAdvance?: () => Promise<AdvanceResult>;
  loopCollection?: LoopCollectionChoice | undefined;
  subtitles?: SubtitleTrackModel | undefined;
  localSources?: readonly QualitySource[] | undefined;
  localSourceId?: string | undefined;
  onSelectLocalSource?: ((assetId: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const onFailure = useCallback(() => setFailed(true), []);
  const { source, onActiveChange } = props;
  const platform = source.kind === "youtube" || source.kind === "bilibili";
  const local = props.localSrc !== undefined && (source.kind === "local" || failed || props.preferLocal === true);
  const active: ActivePlayer = local ? "local" : platform && !failed ? "iframe" : "none";

  useEffect(() => setFailed(false), [props.onlineAttempt]);
  useEffect(() => onActiveChange?.(active), [active, onActiveChange]);

  let player: ReactNode;
  if (local && props.localSrc !== undefined) {
    player = (
      <LocalPlayer
        src={props.localSrc}
        audioOnly={props.localAudioOnly === true}
        {...(props.chapters === undefined ? {} : { chapters: props.chapters })}
        {...(props.autoplay === undefined ? {} : { autoplay: props.autoplay })}
        {...(props.onEndedAdvance === undefined ? {} : { onEndedAdvance: props.onEndedAdvance })}
        loopCollection={props.loopCollection}
        subtitles={props.subtitles}
        activeSourceId={props.localSourceId}
        {...(props.localAudioOnly === true || props.localSources === undefined
          ? {}
          : { sources: props.localSources, onSelectSource: props.onSelectLocalSource })}
      />
    );
  } else if (failed && platform) {
    player = (
      <FailedPlayer
        {...(source.originalUrl === undefined ? {} : { originalUrl: source.originalUrl })}
        {...(props.onCache === undefined ? {} : { onCache: props.onCache })}
      />
    );
  } else if (source.kind === "youtube") {
    player = <YoutubePlayer videoId={source.videoId} onFailure={onFailure} />;
  } else if (source.kind === "bilibili") {
    player = <BilibiliPlayer source={source} />;
  } else {
    player = (
      <div className="flex aspect-video w-full items-center justify-center rounded-md bg-sunken p-4 text-center text-sm text-muted" data-testid="player-unavailable">
        {source.kind === "local" ? (props.localHint ?? t("contentView.player.localClientOnly")) : t("contentView.player.none")}
      </div>
    );
  }
  return (
    <>
      {player}
      {active === "iframe" && props.subtitles !== undefined && (props.subtitles.mode !== "off" || props.subtitles.editing) ? (
        <p className="mt-1 text-xs text-muted" data-testid="player-subtitles-iframe-hint">
          {t("contentView.player.subtitles.iframeHint")}
        </p>
      ) : null}
      {props.renderBelow?.(active)}
    </>
  );
}

/** The iframe failed and no cached copy plays: offer caching (desktop client) or the original page. */
function FailedPlayer(props: { originalUrl?: string; onCache?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-md bg-sunken p-4 text-center text-sm" data-testid="player-failed">
      <p>{t("contentView.player.failed")}</p>
      <div className="flex gap-2">
        {props.onCache === undefined ? (
          <Button size="sm" disabled title={t("contentView.player.clientOnly")}>
            {t("contentView.player.cacheToPlay")}
          </Button>
        ) : (
          <Button size="sm" onClick={props.onCache} data-testid="player-cache">
            {t("contentView.player.cacheToPlay")}
          </Button>
        )}
        {props.originalUrl === undefined ? null : (
          <a className="inline-flex h-7 items-center rounded-md border border-line px-2 text-xs" href={props.originalUrl} target="_blank" rel="noopener noreferrer">
            {t("contentView.player.openOriginal")}
          </a>
        )}
      </div>
    </div>
  );
}
