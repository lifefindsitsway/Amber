import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { FIGURE_UPLOAD_MAX_BYTES, FIGURES_PER_CONTENT_MAX, SAVE_NOTICE_DISMISS_MS } from "../../../shared/defaults.ts";
import type { FigureDto, FigureListDto } from "../../../shared/dto/figure.ts";
import { ApiError } from "../../api/client.ts";
import { contentKeys } from "./content-data.ts";
import { useReaderFigures, type FigureInsertTarget, type ReaderFigureApi } from "./figure-context.ts";
import { rememberedFigureWidth, useCaptureFigure, useFigureActions, useUploadFigure } from "./figure-data.ts";

/** What the file picker offers; the server still decides by the file's bytes. */
export const FIGURE_UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp";
const MEBIBYTE = 1024 * 1024;

/** The upload limit as people read it: `20 MB`. */
export const FIGURE_UPLOAD_MAX_MB = Math.round(FIGURE_UPLOAD_MAX_BYTES / MEBIBYTE);

/** Why a file is not sent at all: the same reasons the server would give, found before the upload. */
export type FigureFileProblem = "unsupported" | "too_large";

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Whether the first bytes of a file are those of a PNG, a JPEG or a WebP image. */
export function isSupportedImageSignature(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith(bytes, [0xff, 0xd8, 0xff]) ||
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
  );
}

/**
 * A quick look at a picked or pasted file before it is sent, so an obvious refusal is said at
 * once instead of after the transfer: too big, or not a PNG, JPEG or WebP by its first bytes
 * (the name and the declared type are not trusted). The server checks everything again.
 */
export async function checkFigureFile(file: Blob): Promise<FigureFileProblem | undefined> {
  if (file.size > FIGURE_UPLOAD_MAX_BYTES) return "too_large";
  if (file.size === 0) return "unsupported";
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return isSupportedImageSignature(head) ? undefined : "unsupported";
}

/**
 * Where an upload goes when nothing marks a paragraph (no selection, nothing followed, nothing
 * in view, which only a list not laid out yet can have): after the opening paragraph.
 */
export function insertTarget(api: Pick<ReaderFigureApi, "captureTarget" | "targetForTime">): FigureInsertTarget | undefined {
  return api.captureTarget() ?? api.targetForTime(0);
}

/** What the menu fixed when it was opened: the paragraph an upload goes after, and the frame on screen with its place. */
export interface FrozenInsert {
  target: FigureInsertTarget | undefined;
  frame: { assetId: string; atMs: number; target: FigureInsertTarget | undefined } | undefined;
}

/**
 * Fixes the places at the moment the menu opens: the paragraph of the selection, the one
 * followed or the first in view, and the frame on screen with the paragraph its time falls in.
 * Playback or scrolling while the menu is open, or while a file is being picked, moves neither.
 */
export function freezeInsert(api: Pick<ReaderFigureApi, "captureTarget" | "targetForTime"> | undefined, request: (() => { assetId: string; atMs: number }) | undefined): FrozenInsert {
  if (api === undefined) return { target: undefined, frame: undefined };
  const frame = request?.();
  return { target: insertTarget(api), frame: frame === undefined ? undefined : { ...frame, target: api.targetForTime(frame.atMs) } };
}

/** Live and recently deleted figures both count against the per-Content cap. */
export function figuresAtLimit(list: FigureListDto | undefined): boolean {
  if (list === undefined) return false;
  return list.items.length + list.recentlyDeleted.length >= list.limit;
}

function detail(error: ApiError, key: string): unknown {
  return error.error.details?.[key];
}

/** A failed insert, capture or restore in words, with what can be done about it. */
export function figureInsertErrorText(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("figureInsert.error.unknown");
  const code = error.error.code;
  const reason = detail(error, "reason");
  switch (code) {
    case "invalid_request.figure_image":
      if (reason === "corrupt" || reason === "too_large" || reason === "too_many_pixels" || reason === "unsupported") return t(`figureInsert.error.image.${reason}`, { size: FIGURE_UPLOAD_MAX_MB });
      return t("figureInsert.error.image.unsupported");
    case "invalid_request.figure_frame":
      if (reason === "no_video" || reason === "past_end" || reason === "failed") return t(`figureInsert.error.frame.${reason}`);
      return t("figureInsert.error.frame.failed");
    case "invalid_request.figure_limit": {
      const limit = detail(error, "limit");
      return t("figureInsert.error.limit", { limit: typeof limit === "number" ? limit : FIGURES_PER_CONTENT_MAX });
    }
    case "invalid_request.figure_anchor":
      return t("figureInsert.error.anchor");
    case "not_found.figure_purged":
      return t("figureInsert.error.purged");
    default:
      if (error.error.class === "media_missing") return t("figureInsert.error.mediaMissing");
      return error.error.userMessage !== "" ? error.error.userMessage : t(`errors.${error.error.class}`);
  }
}

/** The text of a refusal found before sending. */
export function figureFileProblemText(problem: FigureFileProblem, t: TFunction): string {
  return t(`figureInsert.error.image.${problem}`, { size: FIGURE_UPLOAD_MAX_MB });
}

/** What started an insert: the player's capture control, or the reading view (menu, paste). */
export type FigureInsertOrigin = "player" | "reader";
export type FigureInsertKind = "capture" | "upload" | "paste" | "restore";

/**
 * Where one insert stands. `failed` carries the reason in words; a pending upload can be
 * cancelled.
 */
export type FigureInsertStatus = FigureInsertHandle & (
  | { phase: "pending"; cancel?: () => void }
  | { phase: "done" }
  | { phase: "cancelled" }
  | { phase: "failed"; message: string }
);

/** One insert as the status store knows it. */
export interface FigureInsertHandle {
  id: number;
  contentId: string;
  origin: FigureInsertOrigin;
  kind: FigureInsertKind;
}

type Outcome = { phase: "done" } | { phase: "cancelled" } | { phase: "failed"; message: string };

/**
 * Every insert under way and every outcome still said, each by its own handle: two inserts at
 * once (an upload, then a paste) each show, each can be cancelled, and one finishing never
 * stands in for the other. Entries name their Content, so a page shows only its own. Clearing
 * (the page left) cancels what can be cancelled and forgets everything; an insert started
 * before that which still finishes later finds no entry and says nothing.
 */
class FigureInsertStatusStore {
  private entries: readonly FigureInsertStatus[] = [];
  private readonly listeners = new Set<() => void>();
  private next = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** All entries, oldest first; a new array after every change. */
  readonly snapshot = (): readonly FigureInsertStatus[] => this.entries;

  /** The entries of one Content and origin, oldest first. */
  list(contentId: string, origin: FigureInsertOrigin): FigureInsertStatus[] {
    return this.entries.filter((entry) => entry.contentId === contentId && entry.origin === origin);
  }

  /** Whether an insert of `contentId` started from `origin` is under way. */
  pending(contentId: string, origin: FigureInsertOrigin): boolean {
    return this.entries.some((entry) => entry.contentId === contentId && entry.origin === origin && entry.phase === "pending");
  }

  /** Starts an insert; returns its handle, which its outcome names. */
  start(input: { contentId: string; origin: FigureInsertOrigin; kind: FigureInsertKind; cancel?: () => void }): FigureInsertHandle {
    this.next += 1;
    const { cancel, ...rest } = input;
    const handle = { id: this.next, ...rest };
    this.set([...this.entries, { ...handle, phase: "pending", ...(cancel === undefined ? {} : { cancel }) }]);
    return handle;
  }

  /** Records how an insert ended; nothing when its entry is gone (cleared with its page). */
  finish(handle: FigureInsertHandle, outcome: Outcome): void {
    if (!this.entries.some((entry) => entry.id === handle.id)) return;
    this.set(this.entries.map((entry) => (entry.id === handle.id ? { ...handle, ...outcome } : entry)));
  }

  /** Forgets one entry (a dismissed or expired notice). */
  dismiss(id: number): void {
    if (!this.entries.some((entry) => entry.id === id)) return;
    this.set(this.entries.filter((entry) => entry.id !== id));
  }

  /** Shows a refusal found before anything was sent. */
  fail(input: { contentId: string; origin: FigureInsertOrigin; kind: FigureInsertKind; message: string }): void {
    this.next += 1;
    this.set([...this.entries, { id: this.next, ...input, phase: "failed" }]);
  }

  /** Cancels every insert that can be cancelled and forgets everything (the page is left). */
  clear(): void {
    const entries = this.entries;
    if (entries.length === 0) return;
    this.set([]);
    for (const entry of entries) if (entry.phase === "pending") entry.cancel?.();
  }

  private set(entries: readonly FigureInsertStatus[]): void {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

export const figureInsertStatus = new FigureInsertStatusStore();

/** The inserts of `contentId` started from `origin`, oldest first. */
export function useFigureInsertStatuses(contentId: string, origin: FigureInsertOrigin): readonly FigureInsertStatus[] {
  const entries = useSyncExternalStore(figureInsertStatus.subscribe, figureInsertStatus.snapshot);
  return useMemo(() => entries.filter((entry) => entry.contentId === contentId && entry.origin === origin), [entries, contentId, origin]);
}

/** A failure already put in words. */
class InsertFailure extends Error {}

/** How long a success (or a cancel) stays said: long enough to read, short enough not to linger over the text or the picture. */
const DONE_SHOWN_MS = 3000;

/**
 * Lets a finished insert's notice go by itself: a success or a cancel after a moment, a
 * failure after as long as other notices of the app stay (it can be dismissed sooner). A
 * pending insert stays until it ends.
 */
export function useInsertStatusExpiry(status: FigureInsertStatus): void {
  const { id, phase } = status;
  useEffect(() => {
    if (phase === "pending") return undefined;
    const timer = setTimeout(() => figureInsertStatus.dismiss(id), phase === "failed" ? SAVE_NOTICE_DISMISS_MS : DONE_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [id, phase]);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** The inserts the content page offers; each reports through `figureInsertStatus` and reveals what it created. */
export interface FigureInserter {
  /** A frame of `assetId` at `atMs`, placed at `target` (by its capture time when there is none). */
  capture(input: { assetId: string; atMs: number; target: FigureInsertTarget | undefined; origin: FigureInsertOrigin }): Promise<FigureDto | undefined>;
  /** An image file picked or pasted, placed at `target`. Checked here first, then sent; cancellable while sent. */
  upload(input: { file: Blob; target: FigureInsertTarget; origin: FigureInsertOrigin; kind: "upload" | "paste" }): Promise<FigureDto | undefined>;
  /** Brings back a recently deleted figure. */
  restore(input: { figureId: string; origin: FigureInsertOrigin }): Promise<FigureDto | undefined>;
}

/**
 * Inserts into `contentId`'s reading view. A request already at the per-Content cap (as the
 * cached list counts it) is refused without being sent. What was created is revealed by the
 * reading view registered when it arrives, which may be a newer one than at the start.
 */
export function useFigureInserter(contentId: string): FigureInserter {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const api = useReaderFigures();
  const latestApi = useRef<ReaderFigureApi | undefined>(api);
  latestApi.current = api;
  const capture = useCaptureFigure(contentId);
  const upload = useUploadFigure(contentId);
  const actions = useFigureActions(contentId);
  const latest = useRef({ capture: capture.mutateAsync, upload: upload.mutateAsync, actions, t });
  latest.current = { capture: capture.mutateAsync, upload: upload.mutateAsync, actions, t };

  return useMemo<FigureInserter>(() => {
    const atLimit = (): boolean => figuresAtLimit(queryClient.getQueryData<FigureListDto>(contentKeys.figures(contentId)));
    const limitText = (): string => {
      const list = queryClient.getQueryData<FigureListDto>(contentKeys.figures(contentId));
      return latest.current.t("figureInsert.error.limit", { limit: list?.limit ?? FIGURES_PER_CONTENT_MAX });
    };
    const reveal = (figure: FigureDto): void => latestApi.current?.revealFigure(figure.id);
    const run = async (kind: FigureInsertKind, origin: FigureInsertOrigin, request: (signal: AbortSignal) => Promise<FigureDto>, cancellable: boolean): Promise<FigureDto | undefined> => {
      const abort = new AbortController();
      const handle = figureInsertStatus.start({ contentId, origin, kind, ...(cancellable ? { cancel: () => abort.abort() } : {}) });
      try {
        const figure = await request(abort.signal);
        reveal(figure);
        figureInsertStatus.finish(handle, { phase: "done" });
        return figure;
      } catch (error) {
        if (isAbort(error) || abort.signal.aborted) {
          figureInsertStatus.finish(handle, { phase: "cancelled" });
          // The server may have stored the figure just before the cancel reached it: read the list again.
          void queryClient.invalidateQueries({ queryKey: contentKeys.figures(contentId) });
        }
        else figureInsertStatus.finish(handle, { phase: "failed", message: error instanceof InsertFailure ? error.message : figureInsertErrorText(error, latest.current.t) });
        return undefined;
      }
    };
    return {
      capture: async ({ assetId, atMs, target, origin }) => {
        if (atLimit()) {
          figureInsertStatus.fail({ contentId, origin, kind: "capture", message: limitText() });
          return undefined;
        }
        const widthRatio = rememberedFigureWidth();
        return run("capture", origin, () => latest.current.capture({ assetId, atMs, widthRatio, ...(target === undefined ? {} : { placement: target.placement }) }), false);
      },
      upload: async ({ file, target, origin, kind }) => {
        if (atLimit()) {
          figureInsertStatus.fail({ contentId, origin, kind, message: limitText() });
          return undefined;
        }
        const problem = await checkFigureFile(file);
        if (problem !== undefined) {
          figureInsertStatus.fail({ contentId, origin, kind, message: figureFileProblemText(problem, latest.current.t) });
          return undefined;
        }
        const widthRatio = rememberedFigureWidth();
        return run(kind, origin, (signal) => latest.current.upload({ file, meta: { placement: target.placement, widthRatio }, signal }), true);
      },
      restore: async ({ figureId, origin }) =>
        run(
          "restore",
          origin,
          async () => {
            const result = await latest.current.actions.restore(figureId);
            if (result.kind === "saved") return result.figure;
            if (result.kind === "failed") throw result.error;
            throw new InsertFailure(latest.current.t("figures.conflict"));
          },
          false,
        ),
    };
  }, [contentId, queryClient]);
}
