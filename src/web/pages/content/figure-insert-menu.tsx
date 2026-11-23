import type { TFunction } from "i18next";
import { ArchiveRestore, Camera, ChevronDown, ChevronRight, ImageOff, ImagePlus, ImageUp, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { FIGURE_DELETED_RETENTION_DAYS } from "../../../shared/defaults.ts";
import type { FigureDto } from "../../../shared/dto/figure.ts";
import { formatDateTime, formatDuration } from "../../format.ts";
import { useFrameSource } from "../../player/figure-capture.ts";
import { Button, FOCUS_RING } from "../../ui/button.tsx";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "../../ui/context-menu.tsx";
import { Spinner } from "../../ui/feedback.tsx";
import { FieldError, TEXT_ACTION_CLASS } from "../../ui/notice.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";
import { useContentPage } from "./content-context.tsx";
import { pickShownRevision, readableRevisions, useRevisions, useSegments } from "./content-data.ts";
import { useReaderFigures } from "./figure-context.ts";
import { useFigures } from "./figure-data.ts";
import {
  FIGURE_UPLOAD_ACCEPT,
  FIGURE_UPLOAD_MAX_MB,
  figureInsertStatus,
  figuresAtLimit,
  freezeInsert,
  useFigureInserter,
  useFigureInsertStatuses,
  useInsertStatusExpiry,
  type FigureInsertKind,
  type FigureInsertStatus,
  type FrozenInsert,
} from "./figure-insert.ts";
import { useFigureImage } from "./use-figure-image.ts";

const ITEM_CLASS = `${MENU_ITEM_CLASS} items-start`;
/** A sentence under a menu entry (why it is off, what it takes). */
const NOTE_CLASS = "block text-note text-muted";
/** A time under a menu entry. */
const META_CLASS = "block text-xs text-muted";
const isApple = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent);

function Thumbnail(props: { figure: FigureDto }) {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const image = useFigureImage(props.figure, element);
  return (
    <span ref={setElement} aria-hidden="true" className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-sunken text-muted">
      {image.state.status === "loaded" ? <img src={image.state.url} alt="" className="size-full object-cover" /> : image.state.status === "loading" ? <Spinner size={12} /> : <ImageOff size={14} />}
    </span>
  );
}

function figureName(figure: FigureDto, t: TFunction): string {
  const kind = figure.capturedAtMs === undefined ? t("figureInsert.recent.upload") : t("figureInsert.recent.capture", { time: formatDuration(figure.capturedAtMs) });
  return figure.caption === undefined ? kind : `${kind} · ${figure.caption}`;
}

/** The text of an insert under way, by kind. */
const PENDING_KEY = {
  capture: "figureInsert.status.capture",
  upload: "figureInsert.status.upload",
  paste: "figureInsert.status.paste",
  restore: "figureInsert.status.restore",
} as const satisfies Record<FigureInsertKind, string>;
const DONE_KEY = {
  capture: "figureInsert.status.captureDone",
  upload: "figureInsert.status.uploadDone",
  paste: "figureInsert.status.pasteDone",
  restore: "figureInsert.status.restoreDone",
} as const satisfies Record<FigureInsertKind, string>;


/** One insert started in the reading view: under way (with 「取消」 for a file being sent), done, cancelled or failed. */
function StatusLine(props: { status: FigureInsertStatus }) {
  const { t } = useTranslation();
  const { status } = props;
  useInsertStatusExpiry(status);
  if (status.phase === "pending") {
    const cancel = status.cancel;
    return (
      <span className="flex items-center gap-2" data-testid="figure-insert-line" data-phase="pending">
        <Spinner size={12} />
        <span>{t(PENDING_KEY[status.kind])}</span>
        {cancel === undefined ? null : (
          <button type="button" className={TEXT_ACTION_CLASS} aria-label={t("figureInsert.status.cancelLabel")} onClick={cancel} data-testid="figure-insert-cancel">
            {t("figureInsert.status.cancel")}
          </button>
        )}
      </span>
    );
  }
  if (status.phase === "failed") {
    return (
      <span className="flex items-center gap-2" data-testid="figure-insert-line" data-phase="failed">
        <span className="text-danger">{status.message}</span>
        <Tooltip content={t("figureInsert.status.dismiss")}>
          <button
            type="button"
            className={`rounded p-0.5 text-muted transition-colors duration-150 motion-reduce:transition-none hover:bg-sunken hover:text-ink ${FOCUS_RING}`}
            aria-label={t("figureInsert.status.dismiss")}
            onClick={() => figureInsertStatus.dismiss(status.id)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </Tooltip>
      </span>
    );
  }
  return (
    <span className="text-muted" data-testid="figure-insert-line" data-phase={status.phase}>
      {status.phase === "cancelled" ? t("figureInsert.status.cancelled") : t(DONE_KEY[status.kind])}
    </span>
  );
}

/**
 * Whether a box `width` wide put under the start of `anchor` would run past the end of
 * `toolbar`: then it goes under the anchor's end instead. Decided from the start position
 * whatever the alignment is now, so it does not flip back and forth.
 */
export function statusAlignEnd(anchorLeft: number, width: number, toolbarRight: number): boolean {
  return anchorLeft + width > toolbarRight;
}

/**
 * How the inserts started in the reading view go, under the 「插入图片」 button, one line each:
 * every insert under way can be seen and cancelled on its own, outcomes stay for a moment
 * (failures longer, or until dismissed). It floats, so the toolbar does not shift. The two live
 * regions are always there and only their contents change: progress and success are announced
 * politely, a failure at once.
 */
function InsertStatus(props: { contentId: string }) {
  const entries = useFigureInsertStatuses(props.contentId, "reader");
  const calm = entries.filter((entry) => entry.phase !== "failed");
  const failures = entries.filter((entry) => entry.phase === "failed");
  const outer = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<{ alignEnd: boolean; maxWidth: number | undefined }>({ alignEnd: false, maxWidth: undefined });
  useLayoutEffect(() => {
    // outer → the wrapper around the button → the toolbar row.
    const anchor = outer.current?.parentElement;
    const toolbar = anchor?.parentElement;
    if (box.current === null || anchor === null || anchor === undefined || toolbar === null || toolbar === undefined) return;
    const bounds = toolbar.getBoundingClientRect();
    const next = { alignEnd: statusAlignEnd(anchor.getBoundingClientRect().left, box.current.offsetWidth, bounds.right), maxWidth: Math.floor(bounds.width) };
    setPlacement((current) => (current.alignEnd === next.alignEnd && current.maxWidth === next.maxWidth ? current : next));
  }, [entries]);
  return (
    <span ref={outer} className={`absolute top-full z-30 mt-1 ${placement.alignEnd ? "right-0" : "left-0"}`} data-testid="figure-insert-status">
      <span
        ref={box}
        className={`flex w-max max-w-72 flex-col gap-1 text-note ${entries.length === 0 ? "" : "rounded-md border border-line bg-surface px-2 py-1 shadow-sm"}`}
        style={placement.maxWidth === undefined ? undefined : { maxWidth: `min(18rem, ${placement.maxWidth}px)` }}
      >
        <span role="status" aria-live="polite" className="flex flex-col gap-1" data-testid="figure-insert-progress">
          {calm.map((entry) => (
            <StatusLine key={entry.id} status={entry} />
          ))}
        </span>
        <span role="alert" aria-live="assertive" className="flex flex-col gap-1" data-testid="figure-insert-alerts">
          {failures.map((entry) => (
            <StatusLine key={entry.id} status={entry} />
          ))}
        </span>
      </span>
    </span>
  );
}

/**
 * Why the reading view offers no figure API yet, by the state of the text it shows: still
 * loading, failed to load, or without a paragraph to put a figure by. The shown revision is
 * found the way the transcript tab finds it (the address's, else the current one).
 */
function useUnavailableReason(contentId: string, available: boolean): string | undefined {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const revisions = useRevisions(contentId);
  const list = revisions.data;
  const readable = list === undefined ? [] : readableRevisions(list.revisions);
  const requested = params.get("revision");
  const shown = pickShownRevision(readable, list?.primaryTranscriptRevisionId, requested);
  const segments = useSegments(available ? undefined : shown?.id);
  if (available) return undefined;
  if (revisions.isError || segments.isError) return t("figureInsert.menu.loadFailed");
  if (list !== undefined && shown === undefined) return t("figureInsert.menu.noTranscript");
  if (segments.isSuccess && segments.data.length === 0) return t("figureInsert.menu.noParagraphs");
  return t("figureInsert.menu.loading");
}

/**
 * The reading toolbar's 「插入图片」 menu: capture the frame on screen (while the local player
 * shows a video), upload an image, bring back a recently deleted figure, and a word that
 * pasting works too. Off, with the reason beside it, while the reading view cannot take a
 * figure (text still loading, failed to load, or without paragraphs). Places are fixed when
 * the menu opens (see `freezeInsert`); what was inserted is scrolled to and highlighted by the
 * reading view.
 */
export function FigureInsertMenu(): ReactNode {
  const { t, i18n } = useTranslation();
  const { content } = useContentPage();
  const contentId = content.id;
  const api = useReaderFigures();
  const figures = useFigures(contentId, api !== undefined);
  const source = useFrameSource(contentId);
  const inserter = useFigureInserter(contentId);
  const [open, setOpen] = useState(false);
  const frozen = useRef<FrozenInsert>({ target: undefined, frame: undefined });
  const fileInput = useRef<HTMLInputElement>(null);
  const reasonId = useId();
  const limitId = useId();
  const unavailable = useUnavailableReason(contentId, api !== undefined);
  const atLimit = figuresAtLimit(figures.data);
  const limitText = t("figureInsert.menu.atLimit", { limit: figures.data?.limit ?? 0 });
  // The entries the limit turns off name it, so it is read with them.
  const limitNote = atLimit ? { "aria-describedby": limitId } : {};
  const deleted = figures.data?.recentlyDeleted ?? [];
  const captureReason = source?.kind === "video" ? undefined : source?.kind === "audio" ? t("figureInsert.menu.captureNoPicture") : t("figureInsert.menu.captureNeedsVideo");

  const changeOpen = (next: boolean): void => {
    if (next) frozen.current = freezeInsert(api, source?.kind === "video" ? source.request : undefined);
    setOpen(next);
  };
  const capture = (): void => {
    const frame = frozen.current.frame;
    if (frame === undefined) return;
    void inserter.capture({ assetId: frame.assetId, atMs: frame.atMs, target: frame.target, origin: "reader" });
  };
  const upload = (file: File | undefined): void => {
    const target = frozen.current.target;
    if (file === undefined || target === undefined) return;
    void inserter.upload({ file, target, origin: "reader", kind: "upload" });
  };

  return (
    <span className="relative inline-flex">
      <DropdownMenu.Root open={open && unavailable === undefined} onOpenChange={changeOpen} modal={false}>
        <DropdownMenu.Trigger asChild disabled={unavailable !== undefined}>
          <Button size="sm" variant="ghost" title={unavailable} {...(unavailable === undefined ? {} : { "aria-describedby": reasonId })} data-testid="figure-insert">
            <ImagePlus size={14} aria-hidden="true" />
            {t("figureInsert.menu.trigger")}
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={8} className={`${MENU_CONTENT_CLASS} w-72 max-w-[var(--radix-dropdown-menu-content-available-width)]`} data-testid="figure-insert-menu">
            <DropdownMenu.Item className={ITEM_CLASS} disabled={captureReason !== undefined || atLimit} onSelect={capture} {...limitNote} data-testid="figure-insert-capture">
              <Camera size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                {t("figureInsert.menu.capture")}
                {captureReason === undefined ? null : <span className={NOTE_CLASS}>{captureReason}</span>}
              </span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={ITEM_CLASS} disabled={atLimit} onSelect={() => fileInput.current?.click()} {...limitNote} data-testid="figure-insert-upload">
              <ImageUp size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                {t("figureInsert.menu.upload")}
                <span className={NOTE_CLASS}>{t("figureInsert.menu.uploadFormats", { size: FIGURE_UPLOAD_MAX_MB })}</span>
              </span>
            </DropdownMenu.Item>
            {atLimit ? (
              <FieldError id={limitId} className="px-2 py-1" testId="figure-insert-limit">
                {limitText}
              </FieldError>
            ) : null}
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className={`${ITEM_CLASS} data-[state=open]:bg-sunken`} disabled={deleted.length === 0} data-testid="figure-insert-recent">
                <ArchiveRestore size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {t("figureInsert.menu.recent", { count: deleted.length })}
                  {deleted.length === 0 ? <span className={NOTE_CLASS}>{t("figureInsert.menu.recentEmpty")}</span> : null}
                </span>
                {deleted.length === 0 ? null : <ChevronRight size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />}
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent sideOffset={4} collisionPadding={8} className={`${MENU_CONTENT_CLASS} flex max-h-80 w-80 max-w-[var(--radix-dropdown-menu-content-available-width)] flex-col overflow-y-auto`} data-testid="figure-insert-recent-list">
                  <p className="px-2 py-1 text-note text-muted">{t("figureInsert.menu.recentHint", { days: FIGURE_DELETED_RETENTION_DAYS })}</p>
                  {deleted.map((figure) => {
                    const name = figureName(figure, t);
                    return (
                      <DropdownMenu.Item
                        key={figure.id}
                        className={`${MENU_ITEM_CLASS} gap-2.5`}
                        aria-label={t("figureInsert.recent.restoreLabel", { name })}
                        onSelect={() => void inserter.restore({ figureId: figure.id, origin: "reader" })}
                        data-testid="figure-insert-restore"
                        data-figure-id={figure.id}
                      >
                        <Thumbnail figure={figure} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate" title={name}>
                            {name}
                          </span>
                          {figure.deletedAt === undefined ? null : <span className={META_CLASS}>{t("figureInsert.recent.deletedAt", { time: formatDateTime(figure.deletedAt, i18n.language) })}</span>}
                        </span>
                        <span className="shrink-0 text-xs text-link">{t("figureInsert.recent.restore")}</span>
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <p className="px-2 py-1 text-note text-muted" data-testid="figure-insert-paste-hint">
              {t("figureInsert.menu.pasteHint", { keys: t(isApple() ? "figureInsert.menu.pasteKeysMeta" : "figureInsert.menu.pasteKeysCtrl") })}
            </p>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {unavailable === undefined ? null : (
        <span id={reasonId} className="sr-only">
          {unavailable}
        </span>
      )}
      <input
        ref={fileInput}
        type="file"
        accept={FIGURE_UPLOAD_ACCEPT}
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Cleared, so picking the same file again still reports a change.
          event.currentTarget.value = "";
          upload(file);
        }}
        data-testid="figure-insert-file"
      />
      <InsertStatus contentId={contentId} />
    </span>
  );
}
