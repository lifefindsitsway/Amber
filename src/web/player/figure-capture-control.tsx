import { Camera, LoaderCircle } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ContentDetailDto } from "../../shared/dto/content.ts";
import { useReaderFigures } from "../pages/content/figure-context.ts";
import { useFigures } from "../pages/content/figure-data.ts";
import { figureInsertStatus, figuresAtLimit, useFigureInserter, useFigureInsertStatuses, useInsertStatusExpiry, type FigureInsertStatus } from "../pages/content/figure-insert.ts";
import { isNarrowPlayer } from "./danmaku-narrow.ts";
import { capturableAssetIds, frameRequest, frameSources, trackPresentedFrame, useFrameSource } from "./figure-capture.ts";
import type { PlayerExtensionContext, PlayerExtensions } from "./player-extensions.ts";
import { PLAYER_MENU_ITEM_CLASS } from "./player-menus.tsx";

/** Whether the player shows a picture from a file the server can capture from. */
function capturable(context: PlayerExtensionContext, ids: ReadonlySet<string>): boolean {
  return !context.audioOnly && context.video !== null && context.sourceId !== undefined && ids.has(context.sourceId);
}

const NOTICE_CLASS = "rounded bg-black/75 px-3 py-1.5 text-xs text-white";

/** One capture outcome over the picture; it goes by itself after a moment. */
function CaptureNotice(props: { status: FigureInsertStatus }) {
  const { t } = useTranslation();
  useInsertStatusExpiry(props.status);
  const { status } = props;
  return (
    <span className={NOTICE_CLASS} data-testid="player-figure-capture-notice" data-phase={status.phase}>
      {status.phase === "failed" ? status.message : t("figureInsert.capture.done")}
    </span>
  );
}

/**
 * Offers the player's picture to the page while it can be captured (the insert menu reads it),
 * follows which frame is on screen, and says how captures started in the player went: over
 * the picture, so it is seen in fullscreen too, where the reading view is out of sight. The
 * two live regions are always there, so a reader announces what is written into them: a
 * success politely, a failure at once.
 */
function CaptureAgent(props: { contentId: string; context: PlayerExtensionContext; ids: ReadonlySet<string> }) {
  const { contentId, context } = props;
  const api = useReaderFigures();
  const latestApi = useRef(api);
  latestApi.current = api;
  const inserter = useFigureInserter(contentId);
  const video = context.video;
  const assetId = capturable(context, props.ids) ? context.sourceId : undefined;
  const audioOnly = context.audioOnly;

  useEffect(() => {
    if (audioOnly) return frameSources.set({ kind: "audio", contentId });
    if (video === null || assetId === undefined) return undefined;
    const tracker = trackPresentedFrame(video);
    const request = () => frameRequest(video, assetId, tracker.frameMs());
    const clear = frameSources.set({
      kind: "video",
      contentId,
      request,
      // The place is fixed at the press, from the time of the frame taken: playback going on
      // while the server works moves neither. Without the reading view (another tab) the
      // server places the figure by its capture time.
      capture: () => {
        if (figureInsertStatus.pending(contentId, "player")) return;
        const frame = request();
        void inserter.capture({ ...frame, target: latestApi.current?.targetForTime(frame.atMs), origin: "player" });
      },
    });
    return () => {
      clear();
      tracker.stop();
    };
  }, [audioOnly, video, assetId, contentId, inserter]);

  const entries = useFigureInsertStatuses(contentId, "player");
  const said = entries.filter((entry) => entry.phase === "done" || entry.phase === "failed");
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-[2] flex flex-col items-center gap-1 px-2">
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-1" data-testid="player-figure-capture-polite">
        {said.flatMap((entry) => (entry.phase === "done" ? [<CaptureNotice key={entry.id} status={entry} />] : []))}
      </div>
      <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-1" data-testid="player-figure-capture-alerts">
        {said.flatMap((entry) => (entry.phase === "failed" ? [<CaptureNotice key={entry.id} status={entry} />] : []))}
      </div>
    </div>
  );
}

/**
 * Why a capture cannot be made now, if it cannot: no transcript to put a figure in, or the
 * Content already holds as many figures as allowed.
 */
function useCaptureBlock(contentId: string, hasTranscript: boolean): string | undefined {
  const { t } = useTranslation();
  const figures = useFigures(contentId, hasTranscript);
  if (!hasTranscript) return t("figureInsert.menu.noTranscript");
  if (figuresAtLimit(figures.data)) return t("figureInsert.menu.atLimit", { limit: figures.data?.limit ?? 0 });
  return undefined;
}

/** The control-bar button: captures the frame on screen into the reading view. */
function CaptureButton(props: { contentId: string; hasTranscript: boolean }) {
  const { t } = useTranslation();
  const source = useFrameSource(props.contentId);
  const pending = useFigureInsertStatuses(props.contentId, "player").some((entry) => entry.phase === "pending");
  const blocked = useCaptureBlock(props.contentId, props.hasTranscript);
  const reasonId = useId();
  // The name stays while a capture runs; the spinner and `aria-busy` say it is under way.
  const label = t("figureInsert.capture.buttonTitle");
  const off = pending || blocked !== undefined || source?.kind !== "video";
  return (
    <>
      <button
        type="button"
        className={`player-button ${blocked === undefined ? "" : "opacity-50"}`}
        aria-label={label}
        title={blocked ?? label}
        // Stays focusable while off, so keyboard focus is not lost and the reason can be read.
        aria-disabled={off}
        aria-busy={pending}
        {...(blocked === undefined ? {} : { "aria-describedby": reasonId })}
        onClick={() => {
          if (!off && source?.kind === "video") source.capture();
        }}
        data-testid="player-figure-capture"
      >
        {pending ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Camera size={18} aria-hidden="true" />}
      </button>
      {blocked === undefined ? null : (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
    </>
  );
}

/** The same action as a settings-menu entry, where a narrow player puts it; off with the reason under it. */
function CaptureMenuItem(props: { contentId: string; hasTranscript: boolean }) {
  const { t } = useTranslation();
  const source = useFrameSource(props.contentId);
  const pending = useFigureInsertStatuses(props.contentId, "player").some((entry) => entry.phase === "pending");
  const blocked = useCaptureBlock(props.contentId, props.hasTranscript);
  return (
    <DropdownMenu.Item
      className={`${PLAYER_MENU_ITEM_CLASS} flex-col items-start`}
      disabled={pending || blocked !== undefined || source?.kind !== "video"}
      onSelect={() => {
        if (source?.kind === "video") source.capture();
      }}
      data-testid="player-settings-figure-capture"
    >
      <span>{t("figureInsert.capture.menuItem")}</span>
      {blocked === undefined ? null : <span className="max-w-48 text-xs text-white/70">{blocked}</span>}
    </DropdownMenu.Item>
  );
}

/**
 * The player's 「截图」 button: present while the picture is a video file the server can read
 * (the extension itself is always there: it also tells the insert menu what is playing). Off, with the reason, while there is no transcript to
 * put a figure in or the Content holds as many figures as allowed. Stable across renders while
 * nothing it depends on changes. A narrow picture (the same width rule as the danmaku button,
 * so both move together) puts it into the settings menu instead.
 */
export function useFigureCaptureExtension(content: ContentDetailDto): PlayerExtensions {
  const contentId = content.id;
  const hasTranscript = content.primaryTranscriptRevisionId !== undefined;
  const idsKey = capturableAssetIds(content.media).join(" ");
  return useMemo(() => {
    const ids: ReadonlySet<string> = new Set(idsKey === "" ? [] : idsKey.split(" "));
    return {
      pictureLayers: (context) => <CaptureAgent contentId={contentId} context={context} ids={ids} />,
      controls: (context) =>
        capturable(context, ids) && !isNarrowPlayer(context.picture) ? (
          <span className="flex" data-control="figure-capture">
            <CaptureButton contentId={contentId} hasTranscript={hasTranscript} />
          </span>
        ) : null,
      settingsItems: (context) => (capturable(context, ids) && isNarrowPlayer(context.picture) ? <CaptureMenuItem contentId={contentId} hasTranscript={hasTranscript} /> : null),
    } satisfies PlayerExtensions;
  }, [contentId, hasTranscript, idsKey]);
}
