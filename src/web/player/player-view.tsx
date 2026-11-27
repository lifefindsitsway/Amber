import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { platformCapabilities } from "../../shared/platforms.ts";
import type { Platform } from "../../shared/enums.ts";
import { Button, FOCUS_RING } from "../ui/button.tsx";
import { InlineNote, NOTE_TEXT_CLASS } from "../ui/notice.tsx";
import { BilibiliPlayer } from "./bilibili-player.tsx";
import { isEmbedded, type PlayerSource } from "./capabilities.ts";
import type { AdvanceResult, LoopCollectionChoice } from "./list-loop.ts";
import { LocalPlayer } from "./local-player.tsx";
import type { PlayerExtensions } from "./player-extensions.ts";
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
 * A platform without an embeddable player plays its cached copy as soon as there is one;
 * until then a panel says why nothing plays and offers the original page and caching.
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
  /** Features drawn on and added to the `<video>` player; the platform iframes take none. */
  extensions?: PlayerExtensions | undefined;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const onFailure = useCallback(() => setFailed(true), []);
  const { source, onActiveChange } = props;
  const embedded = isEmbedded(source);
  const cacheOnly = source.kind === "no_online_player";
  const local = props.localSrc !== undefined && (source.kind === "local" || cacheOnly || failed || props.preferLocal === true);
  const active: ActivePlayer = local ? "local" : embedded && !failed ? "iframe" : "none";

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
        extensions={props.extensions}
        {...(props.localAudioOnly === true || props.localSources === undefined
          ? {}
          : { sources: props.localSources, onSelectSource: props.onSelectLocalSource })}
      />
    );
  } else if (failed && embedded) {
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
  } else if (source.kind === "no_online_player") {
    player = (
      <NoOnlinePlayer
        platform={source.platform}
        {...(source.originalUrl === undefined ? {} : { originalUrl: source.originalUrl })}
        {...(props.onCache === undefined ? {} : { onCache: props.onCache })}
      />
    );
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
        <InlineNote className="mt-1.5" testId="player-subtitles-iframe-hint">
          {t("contentView.player.subtitles.iframeHint")}
        </InlineNote>
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
          <a className={OPEN_ORIGINAL_CLASS} href={props.originalUrl} target="_blank" rel="noopener noreferrer">
            {t("contentView.player.openOriginal")}
          </a>
        )}
      </div>
    </div>
  );
}

const OPEN_ORIGINAL_CLASS = `inline-flex h-7 items-center rounded-md border border-line bg-surface px-2 text-xs font-medium transition duration-150 motion-reduce:transition-none hover:bg-sunken ${FOCUS_RING}`;

/**
 * Stands where the player would be for a platform that offers no embeddable player and a
 * Content with no playable cache yet, so the column never shows an empty black box. Caching
 * exists only in the desktop client (`onCache`); elsewhere the button stays greyed and the
 * reason is written out, not left to a hover tooltip. A platform whose links carry an expiring
 * access parameter warns that the original page may no longer open.
 */
function NoOnlinePlayer(props: { platform: Platform; originalUrl?: string; onCache?: () => void }) {
  const { t } = useTranslation();
  const noteId = useId();
  const name = t(`common.source.${props.platform}`);
  return (
    <div
      className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-md border border-line bg-sunken p-4 text-center text-sm"
      data-testid="player-no-online"
    >
      <p className="max-w-prose font-medium text-ink" data-testid="player-no-online-reason">
        {t("contentView.player.noOnlinePlayer.reason", { platform: name })}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {props.originalUrl === undefined ? null : (
          <a className={OPEN_ORIGINAL_CLASS} href={props.originalUrl} target="_blank" rel="noopener noreferrer" data-testid="player-open-original">
            {t("contentView.player.openOriginal")}
          </a>
        )}
        {props.onCache === undefined ? (
          <Button size="sm" disabled aria-describedby={noteId} data-testid="player-cache">
            {t("contentView.player.cacheToPlay")}
          </Button>
        ) : (
          <Button size="sm" onClick={props.onCache} data-testid="player-cache">
            {t("contentView.player.cacheToPlay")}
          </Button>
        )}
      </div>
      {props.onCache === undefined ? (
        <p id={noteId} className={`max-w-prose ${NOTE_TEXT_CLASS}`} data-testid="player-cache-client-only">
          {t("contentView.player.noOnlinePlayer.cacheClientOnly")}
        </p>
      ) : null}
      {platformCapabilities(props.platform).linkMayExpire ? (
        <p className={`max-w-prose ${NOTE_TEXT_CLASS}`} data-testid="player-link-may-expire">
          {t("contentView.player.noOnlinePlayer.linkMayExpire")}
        </p>
      ) : null}
    </div>
  );
}
