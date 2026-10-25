import { useMutation } from "@tanstack/react-query";
import { cacheDismissedStorageKey } from "../../cache-dismissed.ts";
import {
  ArrowLeftRight,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FolderPlus,
  HardDriveDownload,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Pin,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { BREAKPOINT_DRAWER_PX, BREAKPOINT_SINGLE_PX, HIGHLIGHT_THRESHOLD_DEFAULT } from "../../../shared/defaults.ts";
import type { ContentDetailDto } from "../../../shared/dto/content.ts";
import type { TaskDetailDto } from "../../../shared/dto/task.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { usePlatformAccounts } from "../../api/queries.ts";
import { ChatComposer, ChatComposerProvider, useChatComposer } from "../../chat/chat-composer.tsx";
import { ChatPanel } from "../../chat/chat-panel.tsx";
import { SelectionToolbar } from "../../chat/selection-toolbar.tsx";
import { NotePopover } from "../../notes/note-popover.tsx";
import { NoteSelectionActions } from "../../notes/note-selection-actions.tsx";
import { NotesUiProvider } from "../../notes/note-ui-context.tsx";
import { CollectionMembershipDialog } from "../../components/collection-membership-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { RenameContentDialog } from "../../components/rename-content-dialog.tsx";
import { formatDuration, formatPublishedDate, formatPublishedDateTime } from "../../format.ts";
import { useMainWidth, useWindowWidth } from "../../layout-width.tsx";
import { playerSourceOf } from "../../player/capabilities.ts";
import { saveCachedCopy } from "../../desktop/cached-media.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { allPlayableCaches, cacheHeight, isAudioOnly, playableCache, playableVideoCaches, qualityLabel, usePlaybackMedia, type LocalAsset } from "../../player/media-url.ts";
import { useListLoopEntry, useLoopCollectionChoice, usePlaylistAdvance, type AdvanceResult, type LoopCollectionChoice } from "../../player/list-loop.ts";
import { PlayerController, PlayerControllerProvider, usePlayerCapabilities } from "../../player/player-controller.tsx";
import { PlayerView, type ActivePlayer } from "../../player/player-view.tsx";
import type { SubtitleTrackModel } from "../../player/subtitle-overlay.tsx";
import { HighlightsBelowPlayer, Timeline } from "../../player/timeline.tsx";
import { Button } from "../../ui/button.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { Splitter } from "../../ui/splitter.tsx";
import { useAutoDismiss } from "../../use-auto-dismiss.ts";
import { useDocumentTitle } from "../../use-document-title.ts";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { DeleteContentDialog } from "../../components/delete-content-dialog.tsx";
import { CacheMediaDialog } from "./cache-media-dialog.tsx";
import { ContentPageProvider, useContentPage, type ContentPageState, type ContentTab, type SegmentSelection } from "./content-context.tsx";
import { useChapters, useContentDetail, useContentTaskRefresh, useHighlights, useUnfinishedCacheTask } from "./content-data.ts";
import type { QualitySource } from "../../player/player-menus.tsx";
import { useContentSubtitles } from "./content-subtitles.ts";
import { visibleHighlights } from "./highlight-items.ts";
import { OutputTabs } from "./output-tabs.tsx";
import { missingOriginal, RelinkBanner } from "./relink-banner.tsx";
import { TrackedTask } from "./tracked-task.tsx";

const WIDTH_KEY = "amber.content.outputsWidth";
const SWAP_KEY = "amber.content.swapped";
const MIDDLE_KEY = "amber.content.middleCollapsed";
const OUTPUTS_MIN_PX = 320;
const MIDDLE_MIN_PX = 360;
const OUTPUTS_DEFAULT_PX = 480;
/** The splitter and column borders between the middle and right columns. */
const GUTTER_PX = 8;

/** `/contents/:id`: player and dialogue in the middle, outputs on the right. */
export function ContentPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const content = useContentDetail(id);
  useContentTaskRefresh(id);
  if (content.isPending) return <Loading />;
  if (content.isError) {
    return content.error instanceof ApiError ? (
      <div className="p-6">
        <ErrorView error={content.error.error} />
      </div>
    ) : (
      <EmptyState title={t("common.state.loadFailed")} />
    );
  }
  return <ContentLayout key={id} content={content.data} />;
}

function ContentLayout(props: { content: ContentDetailDto }) {
  const { content } = props;
  useDocumentTitle(content.title);
  const [params, setParams] = useSearchParams();
  const [controller] = useState(() => new PlayerController());
  const [composer] = useState(() => new ChatComposer());
  const [selection, setSelection] = useState<SegmentSelection | undefined>(() => {
    const segmentId = params.get("segment");
    const revisionId = params.get("revision") ?? content.primaryTranscriptRevisionId;
    return segmentId === null || revisionId === undefined ? undefined : { revisionId, segmentId };
  });
  const [highlightThreshold, setHighlightThreshold] = useState(HIGHLIGHT_THRESHOLD_DEFAULT);
  // Bumped by every 「样式与位置」 request from elsewhere on the page (the export dialog).
  const [subtitleEditRequest, setSubtitleEditRequest] = useState(0);
  const [playingAssetId, setPlayingAssetId] = useState<string | undefined>(undefined);

  const state = useMemo<ContentPageState>(
    () => ({
      content,
      primaryRevisionId: content.primaryTranscriptRevisionId,
      selection,
      select: (next, startMs) => {
        setSelection(next);
        if (startMs !== undefined) controller.seek(startMs);
        const search = new URLSearchParams(window.location.search);
        search.set("segment", next.segmentId);
        setParams(search, { replace: true });
      },
      openTab: (tab: ContentTab) => {
        const search = new URLSearchParams(window.location.search);
        search.set("tab", tab);
        setParams(search, { replace: true });
      },
      highlightThreshold,
      setHighlightThreshold,
      openSubtitleEditor: () => setSubtitleEditRequest((request) => request + 1),
      playingAssetId,
    }),
    [content, selection, controller, setParams, highlightThreshold, playingAssetId],
  );

  return (
    <PlayerControllerProvider controller={controller}>
      <ContentPageProvider value={state}>
        <ChatComposerProvider composer={composer}>
          {/* Above the tabs, so a note draft survives switching tab or revision. */}
          <NotesUiProvider>
            <Columns subtitleEditRequest={subtitleEditRequest} onPlayingCache={setPlayingAssetId} />
            <SelectionToolbar
              actions={(snapshot, close) =>
                snapshot.bounds === undefined ? null : <NoteSelectionActions bounds={snapshot.bounds} rect={snapshot.rect} close={close} />
              }
            />
            <NotePopover />
          </NotesUiProvider>
        </ChatComposerProvider>
      </ContentPageProvider>
    </PlayerControllerProvider>
  );
}

/** Local playback state shared by the toolbar and the player (desktop client). */
interface PlaybackControls {
  /** Play the cached copy instead of the platform iframe. */
  preferLocal: boolean;
  /** Undefined where there is no cached copy to switch to. */
  playLocal?: () => void;
  /** The cached copy to switch to has no picture (only an audio cache exists). */
  cacheAudioOnly: boolean;
  /** Back to the platform iframe; also retries it after it failed and fell back to the cache. */
  playOnline: () => void;
  /** Bumped by `playOnline`, so the player forgets an earlier iframe failure. */
  onlineAttempt: number;
  /** The player actually on screen, as the player reports it. */
  active: ActivePlayer;
  /** Start the local player at once: the page was reached by the list loop. */
  autoplayLocal: boolean;
  /** The list loop's step at the end of local playback. */
  advance: () => Promise<AdvanceResult>;
  /** Which collection the list loop follows, for a Content in several collections. */
  loopCollection: LoopCollectionChoice | undefined;
  setActive: (active: ActivePlayer) => void;
  /** Opens the cache dialog; undefined where caching is unavailable. */
  openCache?: () => void;
  cacheTaskId?: string;
  /** Called with the final snapshot once the cache Task succeeded. */
  cacheSucceeded: (detail: TaskDetailDto) => void;
  clearCacheTask: () => void;
  /** The last cache Task asked for a video but the Content has no picture, so audio was cached. */
  cachedAudioInstead: boolean;
  dismissCachedAudio: () => void;
  /** The video cache the local player should load: the newest of the chosen quality, else the best one. */
  cacheAssetId?: string;
  /** Every playable video cache by quality, as the player's quality menu lists them. */
  cacheSources: QualitySource[];
  selectCache: (assetId: string) => void;
  /** Says the chosen quality went away and which one plays instead. */
  qualityNotice?: string;
  dismissQualityNotice: () => void;
  /** Reports the video cache the local player shows, for the subtitled video export. */
  onPlayingCache: (assetId: string | undefined) => void;
}

/** Whether a finished cache Task fell back to audio because the Content has no picture. */
export function cachedAudioInstead(detail: TaskDetailDto): boolean {
  return detail.stageRuns.some((run) => run.stage === "cache_media" && run.reasons?.includes("audio_only") === true);
}

/**
 * `subtitleEditRequest` opens the subtitle editor where it can be seen: the player is shown,
 * the middle column is the one on screen, and a platform Content plays its cached copy in
 * the local player when there is one (the iframe cannot carry subtitles; without a cache it
 * says so under the player).
 */
function Columns(props: { subtitleEditRequest: number; onPlayingCache: (assetId: string | undefined) => void }) {
  const { t } = useTranslation();
  const { content } = useContentPage();
  const desktop = useDesktop();
  // Breakpoints follow the window as before; the right column's room is what the sidebar leaves.
  const width = useWindowWidth();
  const mainWidth = useMainWidth();
  const entry = useListLoopEntry();
  const advance = usePlaylistAdvance(content);
  const loopCollection = useLoopCollectionChoice(content);
  // A list-loop arrival plays the cached copy; it applies only while one exists (`preferLocal && cached`).
  const [preferLocal, setPreferLocal] = useState(entry.autoplayLocal);
  const [autoplayLocal, setAutoplayLocal] = useState(entry.autoplayLocal);
  const [onlineAttempt, setOnlineAttempt] = useState(0);
  const [active, setActive] = useState<ActivePlayer>("none");
  const [caching, setCaching] = useState(false);
  const [cacheTaskId, setCacheTaskId] = useState<string | undefined>(undefined);
  const [audioInstead, setAudioInstead] = useState(false);
  const platform = content.source.kind === "youtube" || content.source.kind === "bilibili";
  const cache = playableCache(content);
  const cached = cache !== undefined;
  const videoCaches = playableVideoCaches(content);
  // The chosen quality (a height, "" for an unknown one) holds for this page whatever file
  // carries it, so a cache replaced at the same quality is picked up by itself.
  const [selectedQuality, setSelectedQuality] = useState<string | undefined>(undefined);
  const [qualityNotice, setQualityNotice] = useState<string | undefined>(undefined);
  const qualityOf = (asset: LocalAsset): string => String(cacheHeight(asset) ?? "");
  const chosenCache = selectedQuality === undefined ? undefined : videoCaches.find((asset) => qualityOf(asset) === selectedQuality);
  const effectiveCache = chosenCache ?? videoCaches[0];
  const qualityKey = videoCaches.map(qualityOf).join(",");
  const bestLabel = videoCaches[0] === undefined ? undefined : qualityLabel(cacheHeight(videoCaches[0]), t);
  useEffect(() => {
    if (selectedQuality === undefined || chosenCache !== undefined) return;
    setSelectedQuality(undefined);
    if (bestLabel !== undefined) setQualityNotice(t("contentView.player.quality.unavailable", { label: bestLabel }));
    // The set of qualities is what matters, not the identity of the list.
  }, [selectedQuality, qualityKey]);
  const dismissedKey = cacheDismissedStorageKey(content.id);
  const unfinishedCache = useUnfinishedCacheTask(content.id, desktop && platform);
  const restored = useRef(false);
  // A reload brings back the card of a cache Task still running, once: from then on the card
  // lives until the Task succeeds or the user closes it, not as long as the query says so.
  useEffect(() => {
    const found = unfinishedCache.data;
    if (restored.current || found === undefined) return;
    restored.current = true;
    if (found === null) return;
    const dismissed = readStorage(dismissedKey);
    if (dismissed === found.id) return;
    if (dismissed !== undefined) removeStorage(dismissedKey);
    setCacheTaskId((current) => current ?? found.id);
  }, [unfinishedCache.data, dismissedKey]);
  const playback: PlaybackControls = {
    preferLocal: preferLocal && cached,
    ...(desktop && platform && cached ? { playLocal: () => setPreferLocal(true) } : {}),
    cacheAudioOnly: cache?.audioOnly === true,
    playOnline: () => {
      setPreferLocal(false);
      setAutoplayLocal(false);
      setOnlineAttempt((attempt) => attempt + 1);
    },
    onlineAttempt,
    active,
    setActive,
    autoplayLocal,
    advance,
    loopCollection,
    ...(desktop && platform ? { openCache: () => setCaching(true) } : {}),
    ...(cacheTaskId === undefined ? {} : { cacheTaskId }),
    cacheSucceeded: (detail) => {
      removeStorage(dismissedKey);
      setCacheTaskId(undefined);
      setAudioInstead(cachedAudioInstead(detail));
    },
    clearCacheTask: () => {
      if (cacheTaskId !== undefined) writeStorage(dismissedKey, cacheTaskId);
      setCacheTaskId(undefined);
    },
    cachedAudioInstead: audioInstead,
    dismissCachedAudio: () => setAudioInstead(false),
    ...(effectiveCache === undefined ? {} : { cacheAssetId: effectiveCache.id }),
    cacheSources: videoCaches.map((asset) => ({ assetId: asset.id, label: qualityLabel(cacheHeight(asset), t) })),
    selectCache: (assetId) => {
      const asset = videoCaches.find((item) => item.id === assetId);
      if (asset === undefined) return;
      setSelectedQuality(qualityOf(asset));
      setQualityNotice(undefined);
    },
    ...(qualityNotice === undefined ? {} : { qualityNotice }),
    dismissQualityNotice: () => setQualityNotice(undefined),
    onPlayingCache: props.onPlayingCache,
  };
  const subtitles = useContentSubtitles(content, props.subtitleEditRequest);
  const [outputsWidth, setOutputsWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || OUTPUTS_DEFAULT_PX);
  const [swapped, setSwapped] = useState(() => localStorage.getItem(SWAP_KEY) === "1");
  const [playerHidden, setPlayerHidden] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [singleView, setSingleView] = useState<"middle" | "outputs">("middle");
  const columns = width >= BREAKPOINT_DRAWER_PX;
  const [middleCollapsed, setMiddleCollapsed] = useState(() => localStorage.getItem(MIDDLE_KEY) === "1");
  const canPlayCache = desktop && platform && cached;
  useEffect(() => {
    if (props.subtitleEditRequest === 0) return;
    setPlayerHidden(false);
    setMiddleCollapsed(false);
    setSingleView("middle");
    if (canPlayCache) setPreferLocal(true);
    // Only a new request acts; the cache state is read as it is at that moment.
  }, [props.subtitleEditRequest]);
  useEffect(() => {
    localStorage.setItem(MIDDLE_KEY, middleCollapsed ? "1" : "0");
  }, [middleCollapsed]);
  // "Explain" pre-fills the chat input and ChatPanel focuses it in its own effect, which runs
  // before any effect here; expanding during render keeps the input visible in that very commit.
  const composer = useChatComposer();
  const prefillSeq = useSyncExternalStore(composer.subscribe, () => composer.snapshot().prefill?.seq);
  const [seenPrefillSeq, setSeenPrefillSeq] = useState(prefillSeq);
  if (prefillSeq !== seenPrefillSeq) {
    setSeenPrefillSeq(prefillSeq);
    if (columns && middleCollapsed) setMiddleCollapsed(false);
  }

  const toolbar = (
    <Toolbar
      desktop={desktop}
      playback={playback}
      playerHidden={playerHidden}
      onTogglePlayer={() => setPlayerHidden(!playerHidden)}
      onSwap={() => {
        localStorage.setItem(SWAP_KEY, swapped ? "0" : "1");
        setSwapped(!swapped);
      }}
      swapped={swapped}
      {...(width < BREAKPOINT_DRAWER_PX && width >= BREAKPOINT_SINGLE_PX ? { onToggleDrawer: () => setDrawerOpen(!drawerOpen) } : {})}
      {...(columns ? { onCollapseMiddle: () => setMiddleCollapsed(true) } : {})}
    />
  );
  const middle = (
    <>
      <MiddleColumn toolbar={toolbar} playerHidden={playerHidden} playback={playback} desktop={desktop} subtitles={subtitles} />
      {playback.openCache === undefined ? null : (
        <CacheMediaDialog
          contentId={content.id}
          title={content.title}
          media={content.media}
          open={caching}
          onOpenChange={setCaching}
          onStarted={(taskId) => {
            // A new Task is not the one the user closed.
            removeStorage(dismissedKey);
            setAudioInstead(false);
            setCacheTaskId(taskId);
          }}
        />
      )}
    </>
  );

  if (width < BREAKPOINT_SINGLE_PX) {
    return (
      <div className="flex h-full flex-col" data-layout="single">
        <div className="flex border-b border-line" role="tablist">
          {(["middle", "outputs"] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={singleView === view}
              className={`flex-1 py-2 text-sm ${singleView === view ? "border-b-2 border-accent font-medium" : "text-muted"}`}
              onClick={() => setSingleView(view)}
            >
              {t(`contentView.layout.${view}`)}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{singleView === "middle" ? middle : <OutputTabs />}</div>
      </div>
    );
  }

  if (width < BREAKPOINT_DRAWER_PX) {
    return (
      <div className="relative flex h-full" data-layout="drawer">
        <div className="min-w-0 flex-1 overflow-auto">{middle}</div>
        {drawerOpen ? (
          <aside className="absolute inset-y-0 right-0 z-20 w-[min(90%,480px)] border-l border-line bg-surface shadow-xl" data-testid="outputs-drawer">
            <OutputTabs />
          </aside>
        ) : null}
      </div>
    );
  }

  const maxOutputs = Math.max(OUTPUTS_MIN_PX, mainWidth - MIDDLE_MIN_PX - GUTTER_PX);
  const clamped = Math.min(maxOutputs, Math.max(OUTPUTS_MIN_PX, outputsWidth));
  const outputs = middleCollapsed ? (
    <section className="h-full min-w-0 flex-1 border-line" data-testid="outputs-column">
      <OutputTabs />
    </section>
  ) : (
    <section className="h-full shrink-0 border-line" style={{ width: clamped }} data-testid="outputs-column">
      <OutputTabs />
    </section>
  );
  const splitter = (
    <Splitter
      label={t("contentView.layout.resize")}
      testId="content-splitter"
      onResize={(delta) => setOutputsWidth((value) => Math.min(maxOutputs, Math.max(OUTPUTS_MIN_PX, value + (swapped ? delta : -delta))))}
      onEnd={() => localStorage.setItem(WIDTH_KEY, String(Math.round(clamped)))}
    />
  );
  const gap = middleCollapsed ? (
    <aside data-testid="middle-collapsed" className={`flex w-9 shrink-0 flex-col items-center border-line pt-2 ${swapped ? "border-l" : "border-r"}`}>
      <button
        type="button"
        aria-label={t("contentView.toolbar.expandMiddle")}
        title={t("contentView.toolbar.expandMiddle")}
        onClick={() => setMiddleCollapsed(false)}
        className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink"
        data-testid="expand-middle"
      >
        {swapped ? <PanelRightOpen size={16} /> : <PanelLeftOpen size={16} />}
      </button>
    </aside>
  ) : (
    splitter
  );
  // The middle column keeps its slot whatever is swapped or collapsed, and collapsing only
  // hides it, so the player and the chat are never remounted.
  return (
    <div className="flex h-full" data-layout="columns">
      {swapped ? outputs : null}
      {swapped ? gap : null}
      <div className={`min-w-0 flex-1 overflow-auto ${middleCollapsed ? "hidden" : ""}`} data-testid="middle-column">
        {middle}
      </div>
      {swapped ? null : gap}
      {swapped ? null : outputs}
    </div>
  );
}

/**
 * One toolbar control: the button in the row, and the same action as a "⋯" menu entry once
 * the middle column has no room for the button.
 */
interface ToolbarItem {
  key: string;
  inline: ReactNode;
  menu: ReactNode;
}

function Toolbar(props: {
  desktop: boolean;
  playback: PlaybackControls;
  playerHidden: boolean;
  onTogglePlayer: () => void;
  onSwap: () => void;
  swapped: boolean;
  onToggleDrawer?: () => void;
  /** Only in the three-column layout. */
  onCollapseMiddle?: () => void;
}) {
  const { t } = useTranslation();
  const { content } = useContentPage();
  const { playback } = props;
  const [managing, setManaging] = useState(false);
  const saveCache = useSaveCache();
  const platform = content.source.kind === "youtube" || content.source.kind === "bilibili";
  const items: ToolbarItem[] = [];
  if (props.onCollapseMiddle !== undefined) {
    const icon = props.swapped ? <PanelRightClose size={14} /> : <PanelLeftClose size={14} />;
    items.push({
      key: "collapse-middle",
      inline: (
        <Button size="sm" variant="ghost" onClick={props.onCollapseMiddle} data-testid="collapse-middle">
          {icon}
          {t("contentView.toolbar.collapseMiddle")}
        </Button>
      ),
      menu: <MenuAction testId="collapse-middle" icon={icon} label={t("contentView.toolbar.collapseMiddle")} onSelect={props.onCollapseMiddle} />,
    });
  }
  const playerIcon = props.playerHidden ? <Eye size={14} /> : <EyeOff size={14} />;
  const playerLabel = props.playerHidden ? t("contentView.toolbar.showPlayer") : t("contentView.toolbar.hidePlayer");
  items.push(
    {
      key: "toggle-player",
      inline: (
        <Button size="sm" variant="ghost" onClick={props.onTogglePlayer} data-testid="toggle-player">
          {playerIcon}
          {playerLabel}
        </Button>
      ),
      menu: <MenuAction testId="toggle-player" icon={playerIcon} label={playerLabel} onSelect={props.onTogglePlayer} />,
    },
    {
      key: "swap",
      inline: (
        <Button size="sm" variant="ghost" onClick={props.onSwap}>
          <ArrowLeftRight size={14} />
          {t("contentView.toolbar.swap")}
        </Button>
      ),
      menu: <MenuAction testId="swap" icon={<ArrowLeftRight size={14} />} label={t("contentView.toolbar.swap")} onSelect={props.onSwap} />,
    },
  );
  if (platform) {
    items.push({
      key: "switch-player",
      inline: <PlayerModeSwitch playback={playback} desktop={props.desktop} />,
      menu: <PlayerModeMenu playback={playback} desktop={props.desktop} />,
    });
  }
  items.push({
    key: "cache-media",
    inline: (
      <Button
        size="sm"
        variant="ghost"
        disabled={playback.openCache === undefined}
        {...(playback.openCache === undefined ? { title: t("contentView.player.clientOnly") } : {})}
        onClick={playback.openCache}
        data-testid="cache-media"
      >
        <HardDriveDownload size={14} />
        {t("contentView.toolbar.cache")}
      </Button>
    ),
    menu: (
      <MenuAction
        testId="cache-media"
        icon={<HardDriveDownload size={14} />}
        label={t("contentView.toolbar.cache")}
        {...(playback.openCache === undefined ? { disabledReason: t("contentView.player.clientOnly") } : { onSelect: playback.openCache })}
      />
    ),
  });
  if (props.desktop && saveCache.caches.length > 0) {
    items.push({ key: "save-cache", inline: <SaveCacheButton save={saveCache} />, menu: <SaveCacheMenu save={saveCache} /> });
  }
  items.push({
    key: "collections",
    inline: (
      <Button size="sm" variant="ghost" onClick={() => setManaging(true)}>
        <FolderPlus size={14} />
        {t("contentView.toolbar.collections")}
      </Button>
    ),
    menu: <MenuAction testId="collections" icon={<FolderPlus size={14} />} label={t("contentView.toolbar.collections")} onSelect={() => setManaging(true)} />,
  });
  if (props.onToggleDrawer !== undefined) {
    items.push({
      key: "toggle-outputs",
      inline: (
        <Button size="sm" variant="ghost" onClick={props.onToggleDrawer} data-testid="toggle-outputs">
          <PanelRight size={14} />
          {t("contentView.layout.outputs")}
        </Button>
      ),
      menu: <MenuAction testId="toggle-outputs" icon={<PanelRight size={14} />} label={t("contentView.layout.outputs")} onSelect={props.onToggleDrawer} />,
    });
  }
  const row = useRef<HTMLDivElement>(null);
  const fit = Math.min(items.length, useFirstLineCount(row, items.map((item) => item.key).join(" ")));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        {/* One line only: whatever wraps is clipped here and offered in the "⋯" menu instead. */}
        <div ref={row} className="relative -m-1 flex h-9 min-w-0 flex-1 flex-wrap content-start items-center gap-1 overflow-hidden p-1" data-testid="toolbar-row">
          {items.map((item, index) => (
            <div
              key={item.key}
              className={`flex shrink-0 ${index < fit ? "" : "invisible"}`}
              inert={index >= fit}
              data-toolbar-item={item.key}
            >
              {item.inline}
            </div>
          ))}
        </div>
        <ContentMenu overflow={items.slice(fit)} />
      </div>
      <SaveCacheStatus save={saveCache} />
      <CollectionMembershipDialog contentId={managing ? content.id : undefined} onOpenChange={setManaging} />
    </div>
  );
}

/**
 * How many leading children of a wrapping row are on its first line. Reading where flex-wrap
 * put them follows every label width (「显示播放器」, 「本地缓存（仅音频）」…) without
 * measuring text; clipped children keep their layout box, so hiding them never moves the line.
 * `layoutKey` names the children, so a changed set is observed afresh.
 */
function useFirstLineCount(row: RefObject<HTMLDivElement | null>, layoutKey: string): number {
  const [fit, setFit] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const children = Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      const first = children[0];
      if (first === undefined) return;
      const lineBottom = first.offsetTop + first.offsetHeight;
      const wrapped = children.findIndex((child) => child.offsetTop >= lineBottom);
      setFit(wrapped === -1 ? Number.POSITIVE_INFINITY : wrapped);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [row, layoutKey]);
  return fit;
}

const MENU_ITEM =
  "flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 outline-none data-highlighted:bg-sunken data-disabled:cursor-not-allowed data-disabled:opacity-50";

/** A toolbar action as a "⋯" menu entry; without `onSelect` it is greyed, saying why underneath. */
function MenuAction(props: { testId: string; icon: ReactNode; label: string; onSelect?: () => void; disabledReason?: string; detail?: string }) {
  const note = props.onSelect === undefined ? props.disabledReason : props.detail;
  return (
    <DropdownMenu.Item className={MENU_ITEM} disabled={props.onSelect === undefined} onSelect={() => props.onSelect?.()} data-testid={`overflow-${props.testId}`}>
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {props.icon}
      </span>
      <MenuLabel label={props.label} note={note} />
    </DropdownMenu.Item>
  );
}

function MenuLabel(props: { label: string; note: string | undefined }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{props.label}</span>
      {props.note === undefined ? null : <span className="max-w-64 break-all text-xs text-muted">{props.note}</span>}
    </span>
  );
}

/** 「在线 | 本地缓存」 inside the "⋯" menu: the checked entry is the player actually on screen. */
function PlayerModeMenu(props: { playback: PlaybackControls; desktop: boolean }) {
  const { t } = useTranslation();
  const { playback } = props;
  const indicator = (
    <span className="mt-0.5 flex w-3.5 shrink-0 justify-center" aria-hidden="true">
      <DropdownMenu.ItemIndicator>
        <Check size={14} />
      </DropdownMenu.ItemIndicator>
    </span>
  );
  return (
    <>
      <DropdownMenu.Label className="px-2 pt-1.5 text-xs text-muted">{t("contentView.toolbar.playerMode")}</DropdownMenu.Label>
      <DropdownMenu.RadioGroup value={playback.active === "local" ? "local" : "online"}>
        <DropdownMenu.RadioItem value="online" className={MENU_ITEM} onSelect={playback.playOnline} data-testid="overflow-switch-player-online">
          {indicator}
          <MenuLabel label={t("contentView.toolbar.playerOnline")} note={undefined} />
        </DropdownMenu.RadioItem>
        <DropdownMenu.RadioItem
          value="local"
          className={MENU_ITEM}
          disabled={playback.playLocal === undefined}
          onSelect={() => playback.playLocal?.()}
          data-testid="overflow-switch-player-local"
        >
          {indicator}
          <MenuLabel
            label={playback.cacheAudioOnly ? t("contentView.toolbar.playerLocalAudio") : t("contentView.toolbar.playerLocal")}
            note={playback.playLocal === undefined ? (props.desktop ? t("contentView.player.notCached") : t("contentView.player.clientOnly")) : undefined}
          />
        </DropdownMenu.RadioItem>
      </DropdownMenu.RadioGroup>
    </>
  );
}

/**
 * 「另存为…」 (desktop client): copies an available platform cache out of the
 * cache directory. With several caches a menu names each file, a video with its quality; cancelling the
 * save dialog says nothing. Owned by the toolbar, so its outcome stays visible while the button
 * sits in the "⋯" menu.
 */
function useSaveCache() {
  const { t } = useTranslation();
  const client = useApi();
  const { content } = useContentPage();
  const caches = allPlayableCaches(content);
  const mutation = useMutation({
    mutationFn: (asset: LocalAsset) => saveCachedCopy(client, asset.id, asset.displayName ?? fileNameOf(asset.localPath)),
  });
  const label = (asset: LocalAsset): string => {
    const name = asset.displayName ?? fileNameOf(asset.localPath);
    return isAudioOnly(asset) ? t("contentView.saveCache.audio", { name }) : t("contentView.saveCache.video", { name, quality: qualityLabel(cacheHeight(asset), t) });
  };
  return { caches, mutation, label };
}

type SaveCache = ReturnType<typeof useSaveCache>;

function SaveCacheButton(props: { save: SaveCache }) {
  const { t } = useTranslation();
  const { caches, mutation, label } = props.save;
  const only = caches.length === 1 ? caches[0] : undefined;
  if (only !== undefined) {
    return (
      <Button size="sm" variant="ghost" disabled={mutation.isPending} title={label(only)} onClick={() => mutation.mutate(only)} data-testid="save-cache">
        <Save size={14} />
        {t("contentView.toolbar.saveCache")}
      </Button>
    );
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" disabled={mutation.isPending} data-testid="save-cache">
          <Save size={14} />
          {t("contentView.toolbar.saveCache")}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          aria-label={t("contentView.saveCache.menu")}
          className="z-50 max-w-96 min-w-48 rounded-md border border-line bg-surface p-1 text-sm shadow-lg"
        >
          {caches.map((asset) => (
            <DropdownMenu.Item
              key={asset.id}
              className="cursor-pointer truncate rounded px-2 py-1.5 outline-none data-highlighted:bg-sunken"
              onSelect={() => mutation.mutate(asset)}
              data-testid={`save-cache-${asset.id}`}
            >
              {label(asset)}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** 「另存为…」 inside the "⋯" menu: one cache is a plain entry, several open a submenu naming each file. */
function SaveCacheMenu(props: { save: SaveCache }) {
  const { t } = useTranslation();
  const { caches, mutation, label } = props.save;
  const only = caches.length === 1 ? caches[0] : undefined;
  if (only !== undefined) {
    return (
      <MenuAction
        testId="save-cache"
        icon={<Save size={14} />}
        label={t("contentView.toolbar.saveCache")}
        detail={label(only)}
        {...(mutation.isPending ? {} : { onSelect: () => mutation.mutate(only) })}
      />
    );
  }
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={MENU_ITEM} disabled={mutation.isPending} data-testid="overflow-save-cache">
        <span className="mt-0.5 shrink-0" aria-hidden="true">
          <Save size={14} />
        </span>
        <span className="flex-1">{t("contentView.toolbar.saveCache")}</span>
        <ChevronRight size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={4}
          aria-label={t("contentView.saveCache.menu")}
          className="z-50 max-w-96 min-w-48 rounded-md border border-line bg-surface p-1 text-sm shadow-lg"
        >
          {caches.map((asset) => (
            <DropdownMenu.Item
              key={asset.id}
              className="cursor-pointer truncate rounded px-2 py-1.5 outline-none data-highlighted:bg-sunken"
              onSelect={() => mutation.mutate(asset)}
              data-testid={`overflow-save-cache-${asset.id}`}
            >
              {label(asset)}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function SaveCacheStatus(props: { save: SaveCache }) {
  const { t } = useTranslation();
  const { mutation } = props.save;
  // `null` means the user cancelled the save dialog: nothing is shown, so nothing to dismiss.
  useAutoDismiss(mutation.data ?? undefined, () => mutation.reset());
  return (
    <>
      {mutation.data === undefined || mutation.data === null ? null : (
        <p className="flex items-center gap-2 text-xs text-ok" role="status" data-testid="save-cache-saved">
          <span className="min-w-0 break-all">{t("contentView.saveCache.saved", { path: mutation.data.savedPath })}</span>
          <button type="button" className="shrink-0 rounded p-0.5 text-muted hover:bg-sunken" aria-label={t("common.action.close")} onClick={() => mutation.reset()}>
            <X size={12} />
          </button>
        </p>
      )}
      {mutation.error === null ? null : (
        <ErrorView error={appErrorOf(mutation.error)}>
          <Button size="sm" variant="ghost" onClick={() => mutation.reset()}>
            {t("common.action.close")}
          </Button>
        </ErrorView>
      )}
    </>
  );
}

/** The last segment of a local path, Windows or POSIX. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

/**
 * 「在线 | 本地缓存」: the pressed half is the player actually on screen, so
 * it also follows an iframe failure that fell back to the cache. 「本地缓存」 needs the
 * desktop client and a cached copy and says which one is missing; with only an audio cache
 * it reads 「本地缓存（仅音频）」.
 */
function PlayerModeSwitch(props: { playback: PlaybackControls; desktop: boolean }) {
  const { t } = useTranslation();
  const { playback } = props;
  const local = playback.active === "local";
  const segment = (pressed: boolean) =>
    `h-7 px-2 text-xs whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${pressed ? "bg-accent-glow text-accent-ink" : "hover:bg-sunken"}`;
  return (
    <div role="group" aria-label={t("contentView.toolbar.playerMode")} className="inline-flex shrink-0 overflow-hidden rounded-md border border-line" data-testid="switch-player">
      <button type="button" className={segment(!local)} aria-pressed={!local} onClick={playback.playOnline} data-testid="switch-player-online">
        {t("contentView.toolbar.playerOnline")}
      </button>
      <button
        type="button"
        className={`${segment(local)} border-l border-line`}
        aria-pressed={local}
        disabled={playback.playLocal === undefined}
        {...(playback.playLocal === undefined ? { title: props.desktop ? t("contentView.player.notCached") : t("contentView.player.clientOnly") } : {})}
        onClick={playback.playLocal}
        data-testid="switch-player-local"
      >
        {playback.cacheAudioOnly ? t("contentView.toolbar.playerLocalAudio") : t("contentView.toolbar.playerLocal")}
      </button>
    </div>
  );
}

/**
 * The toolbar's trailing "⋯" menu: the controls the row has no room for, in
 * toolbar order, then 「删除」, which returns to the library.
 */
function ContentMenu(props: { overflow: ToolbarItem[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { content } = useContentPage();
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="ghost" aria-label={t("contentView.toolbar.more")} data-testid="content-menu">
            <MoreHorizontal size={16} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-36 rounded-md border border-line bg-surface p-1 text-sm shadow-lg">
            {props.overflow.map((item) => (
              <Fragment key={item.key}>{item.menu}</Fragment>
            ))}
            {props.overflow.length === 0 ? null : <DropdownMenu.Separator className="my-1 h-px bg-line" />}
            <DropdownMenu.Item
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-highlighted:bg-sunken"
              onSelect={() => setDeleting(true)}
              data-testid="content-menu-delete"
            >
              <Trash2 size={14} aria-hidden="true" />
              {t("library.deleteContent.action")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DeleteContentDialog
        content={deleting ? { id: content.id, ...(content.title === undefined ? {} : { title: content.title }) } : undefined}
        onOpenChange={setDeleting}
        onDeleted={() => void navigate("/library", { replace: true })}
      />
    </>
  );
}

function MiddleColumn(props: { toolbar: ReactNode; playerHidden: boolean; playback: PlaybackControls; desktop: boolean; subtitles: SubtitleTrackModel | undefined }) {
  const { t } = useTranslation();
  const { content, highlightThreshold } = useContentPage();
  const { playback } = props;
  const source = useMemo(() => playerSourceOf(content), [content]);
  const local = usePlaybackMedia(content, playback.cacheAssetId);
  // The quality menu applies only to a video cache (never to an original file), and the
  // export starts from that cache only while the local player is the one on screen.
  const loadedCache = local.audioOnly ? undefined : playback.cacheSources.find((source) => source.assetId === local.assetId);
  const playingCacheId = playback.active === "local" ? loadedCache?.assetId : undefined;
  const { onPlayingCache } = playback;
  useEffect(() => onPlayingCache(playingCacheId), [onPlayingCache, playingCacheId]);
  useAutoDismiss(playback.qualityNotice, playback.dismissQualityNotice);
  const capabilities = usePlayerCapabilities();
  const chapters = useChapters(content.id);
  const highlights = useHighlights(content.id);
  const chapterList = chapters.data?.current?.chapters ?? [];
  const shownHighlights = visibleHighlights(highlights.data?.current?.items ?? [], highlightThreshold);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {props.toolbar}
      {props.desktop ? <RelinkBanner content={content} /> : null}
      {props.playerHidden ? null : (
        <div>
          <PlayerView
            source={source}
            preferLocal={playback.preferLocal}
            onlineAttempt={playback.onlineAttempt}
            onActiveChange={playback.setActive}
            {...(local.src === undefined ? {} : { localSrc: local.src })}
            localAudioOnly={local.audioOnly}
            localSourceId={local.assetId}
            {...(loadedCache === undefined ? {} : { localSources: playback.cacheSources, onSelectLocalSource: playback.selectCache })}
            {...(playback.openCache === undefined ? {} : { onCache: playback.openCache })}
            {...(props.desktop && missingOriginal(content) !== undefined ? { localHint: t("contentView.player.localMissing") } : {})}
            chapters={chapterList}
            autoplay={playback.autoplayLocal}
            onEndedAdvance={playback.advance}
            loopCollection={playback.loopCollection}
            subtitles={props.subtitles}
            renderBelow={(active) =>
              // The local player draws chapters into its seek bar; only the highlight band stays below it.
              active === "local" ? (
                <HighlightsBelowPlayer durationMs={content.durationMs} chapters={chapterList} highlights={shownHighlights} />
              ) : (
                <>
                  {source.kind === "bilibili" && capabilities.timeTracking === "unsupported" ? (
                    <p className="mt-1 text-xs text-muted" data-testid="bili-hint">
                      {t("contentView.player.trackingUnavailable")}
                    </p>
                  ) : null}
                  <Timeline durationMs={content.durationMs} chapters={chapterList} highlights={shownHighlights} />
                </>
              )
            }
          />
        </div>
      )}
      {playback.qualityNotice === undefined ? null : (
        <p className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm" role="status" data-testid="player-quality-notice">
          <span className="min-w-0 flex-1">{playback.qualityNotice}</span>
          <Button size="sm" variant="ghost" onClick={playback.dismissQualityNotice}>
            {t("common.action.close")}
          </Button>
        </p>
      )}
      <TitleRow content={content} />
      <PlatformLoginExpired content={content} />
      {/* Cache progress sits under the title, right above the chat. The key
          remounts the card for each Task, so its once-only success callback fires for every Task. */}
      {playback.cacheTaskId === undefined ? null : (
        <TrackedTask key={playback.cacheTaskId} taskId={playback.cacheTaskId} onSucceeded={playback.cacheSucceeded} onClose={playback.clearCacheTask} />
      )}
      {playback.cachedAudioInstead ? (
        <p className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm" role="status" data-testid="cache-audio-only">
          <span className="min-w-0 flex-1">{t("contentView.cache.audioOnlyResult")}</span>
          <Button size="sm" variant="ghost" onClick={playback.dismissCachedAudio}>
            {t("common.action.close")}
          </Button>
        </p>
      ) : null}
      <ChatPanel fill={props.playerHidden} />
    </div>
  );
}

function TitleRow(props: { content: ContentDetailDto }) {
  const { t } = useTranslation();
  const { content } = props;
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-1">
        {content.pinnedAt === undefined ? null : (
          <Pin size={14} className="mt-1 shrink-0 text-accent" aria-label={t("library.pinned")} data-testid="content-pinned" />
        )}
        <h1 className="text-base font-semibold" data-testid="content-title">
          {content.title ?? t("contentView.untitled")}
        </h1>
        <button
          type="button"
          className="mt-0.5 shrink-0 rounded p-1 text-muted hover:bg-sunken hover:text-ink"
          aria-label={t("library.rename.action")}
          title={t("library.rename.action")}
          onClick={() => setRenaming(true)}
          data-testid="content-rename"
        >
          <Pencil size={14} />
        </button>
      </div>
      <RenameContentDialog contentId={renaming ? content.id : undefined} onOpenChange={setRenaming} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="rounded bg-sunken px-1.5 py-0.5">{t(`common.source.${content.source.kind}`)}</span>
        {content.publishedAt === undefined ? null : (
          <span title={t("contentView.publishedAt", { time: formatPublishedDateTime(content.publishedAt) })} data-testid="content-published">
            {formatPublishedDate(content.publishedAt)}
          </span>
        )}
        {content.durationMs === undefined ? null : <span>{formatDuration(content.durationMs)}</span>}
        {content.collections.map((collection) => (
          <Link key={collection.id} to={`/collections/${collection.id}`} className="text-accent hover:underline">
            {collection.name}
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * Tells the user their login for this Content's platform has lapsed, so subtitles that
 * need it may not come; a check or failed fetch is what marks it expired.
 */
function PlatformLoginExpired(props: { content: ContentDetailDto }) {
  const { t } = useTranslation();
  const accounts = usePlatformAccounts();
  const kind = props.content.source.kind;
  const account = accounts.data?.accounts.find((item) => item.platform === kind);
  if (account?.status !== "expired") {
    return null;
  }
  return (
    <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs" role="alert" data-testid="platform-login-expired">
      {t("contentView.platformExpired.message", { platform: t(`common.source.${kind}`) })}{" "}
      <Link className="text-accent underline" to="/settings/platform-accounts">
        {t("contentView.platformExpired.link")}
      </Link>
    </p>
  );
}

// Private mode without storage: the dismissal is simply not remembered.
function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered.
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to forget.
  }
}
