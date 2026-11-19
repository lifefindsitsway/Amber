import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { FIGURE_WIDTH_DEFAULT, FIGURE_WIDTH_MIN_RATIO } from "../../../shared/defaults.ts";
import { FIGURE_WIDTH_PREF_KEY } from "../../../shared/danmaku-prefs.ts";
import {
  figureDtoSchema,
  figureListDtoSchema,
  type FigureCaptureRequest,
  type FigureDto,
  type FigureListDto,
  type FigurePatchRequest,
  type FigureUploadMeta,
} from "../../../shared/dto/figure.ts";
import { ApiError, type ApiClient } from "../../api/client.ts";
import { publishFiguresChanged } from "../../api/content-events.ts";
import { useApi, useContentEvents } from "../../api/context.tsx";
import { contentKeys } from "./content-data.ts";

/** The error code a PATCH gets when the figure changed since the version it names. */
const FIGURE_CHANGED = "conflict.figure_changed";

const figuresPath = (contentId: string): string => `/api/contents/${encodeURIComponent(contentId)}/figures`;
const figurePath = (figureId: string): string => `/api/figures/${encodeURIComponent(figureId)}`;

/** The Content's figures: the live ones (placed by the reader) and the recently deleted ones. */
export function useFigures(contentId: string, enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.figures(contentId),
    queryFn: ({ signal }) => client.get(figuresPath(contentId), figureListDtoSchema, { signal }),
    enabled,
  });
}

/**
 * Puts a figure the server just answered with into the cached list at once, so the reading
 * view does not wait for the list to be read again: live figures in `items`, deleted ones in
 * `recentlyDeleted` (newest deletion first). A version older than the cached one is ignored.
 */
export function mergeFigure(list: FigureListDto, figure: FigureDto): FigureListDto {
  const cached = list.items.find((item) => item.id === figure.id) ?? list.recentlyDeleted.find((item) => item.id === figure.id);
  if (cached !== undefined && cached.version > figure.version) return list;
  const items = list.items.filter((item) => item.id !== figure.id);
  const deleted = list.recentlyDeleted.filter((item) => item.id !== figure.id);
  if (figure.deletedAt === undefined) return { ...list, items: [...items, figure], recentlyDeleted: deleted };
  return { ...list, items, recentlyDeleted: [figure, ...deleted].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)) };
}

function storeFigure(queryClient: QueryClient, contentId: string, figure: FigureDto): void {
  queryClient.setQueryData<FigureListDto>(contentKeys.figures(contentId), (list) => (list === undefined ? list : mergeFigure(list, figure)));
}

/**
 * How a change of a figure ended: `saved` with the figure as now stored; `conflict` when the
 * figure was changed elsewhere meanwhile (the list is being read again, the caller says so);
 * `failed` with the error for anything else.
 */
export type FigureChangeResult = { kind: "saved"; figure: FigureDto } | { kind: "conflict" } | { kind: "failed"; error: unknown };

/** What the reading view does to existing figures. Every call names the version the user acted on. */
export interface FigureActions {
  patch(figure: Pick<FigureDto, "id" | "version">, change: Omit<FigurePatchRequest, "version">): Promise<FigureChangeResult>;
  /** Moves the figure to the recently deleted ones; deleting one already deleted answers it again. */
  remove(figureId: string): Promise<FigureChangeResult>;
  restore(figureId: string): Promise<FigureChangeResult>;
}

/**
 * The changes of one figure in flight from this page, in order, and the version this page's own
 * last change of it came back with. Kept per query client, so every component of the page
 * (the reading view, the insert menu's 「最近删除」) shares them.
 */
interface FigureQueue {
  chains: Map<string, Promise<unknown>>;
  versions: Map<string, number>;
}
const queues = new WeakMap<QueryClient, FigureQueue>();
function queueOf(queryClient: QueryClient): FigureQueue {
  let queue = queues.get(queryClient);
  if (queue === undefined) {
    queue = { chains: new Map(), versions: new Map() };
    queues.set(queryClient, queue);
  }
  return queue;
}

/**
 * Runs `step` after every change of the figure this page already sent, so changes of one figure
 * reach the server one after another, in the order they were made: a quick move then delete, or
 * a delete then undo, can never overtake each other. A failure does not stop the ones after it.
 */
export function inFigureOrder<T>(queue: Pick<FigureQueue, "chains">, figureId: string, step: () => Promise<T>): Promise<T> {
  const previous = queue.chains.get(figureId) ?? Promise.resolve();
  const next = previous.then(step);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  queue.chains.set(figureId, settled);
  // The entry goes once the last change of the figure is done, so the map does not grow.
  void settled.then(() => {
    if (queue.chains.get(figureId) === settled) queue.chains.delete(figureId);
  });
  return next;
}

/**
 * The page's figure changes. Changes of one figure go out one after another (`inFigureOrder`),
 * and a PATCH names the newer of the version the caller saw and the one this page's own last
 * change came back with: quick successive changes never conflict with each other, while a
 * change made in another window still does. Each success updates the cached list, reads it
 * again and tells the other windows (`publishFiguresChanged`); a version conflict reads the
 * list again so the view shows what the other window saved.
 */
export function useFigureActions(contentId: string): FigureActions {
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  const run = useCallback(
    (figureId: string, request: (queue: FigureQueue) => Promise<FigureDto>): Promise<FigureChangeResult> => {
      const queue = queueOf(queryClient);
      return inFigureOrder(queue, figureId, async (): Promise<FigureChangeResult> => {
        try {
          const figure = await request(queue);
          queue.versions.set(figure.id, Math.max(figure.version, queue.versions.get(figure.id) ?? 0));
          storeFigure(queryClient, contentId, figure);
          publishFiguresChanged(events, queryClient, contentId);
          return { kind: "saved", figure };
        } catch (error) {
          if (error instanceof ApiError && error.error.code === FIGURE_CHANGED) {
            await queryClient.invalidateQueries({ queryKey: contentKeys.figures(contentId) });
            return { kind: "conflict" };
          }
          return { kind: "failed", error };
        }
      });
    },
    [contentId, events, queryClient],
  );
  return useMemo(
    () => ({
      patch: (figure, change) =>
        run(figure.id, (queue) => client.patch(figurePath(figure.id), figureDtoSchema, { body: { ...change, version: Math.max(figure.version, queue.versions.get(figure.id) ?? 0) } })),
      remove: (figureId) => run(figureId, () => client.delete(figurePath(figureId), figureDtoSchema)),
      restore: (figureId) => run(figureId, () => client.post(`${figurePath(figureId)}/restore`, figureDtoSchema)),
    }),
    [client, run],
  );
}

function afterCreate(queryClient: QueryClient, events: ReturnType<typeof useContentEvents>, contentId: string, figure: FigureDto): void {
  storeFigure(queryClient, contentId, figure);
  publishFiguresChanged(events, queryClient, contentId);
}

/**
 * `POST /api/contents/:id/figures/capture`: a frame of one of the Content's video files. On
 * success the figure is in the cached list and other windows are told; the caller then asks the
 * reading view to reveal it (`ReaderFigureApi.revealFigure`). Errors are `ApiError`s
 * (`invalid_request.figure_frame`, `invalid_request.figure_limit`, …).
 */
export function useCaptureFigure(contentId: string): UseMutationResult<FigureDto, Error, FigureCaptureRequest> {
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  return useMutation({
    mutationFn: (request: FigureCaptureRequest) => client.post(`${figuresPath(contentId)}/capture`, figureDtoSchema, { body: request, idempotent: true }),
    onSuccess: (figure) => afterCreate(queryClient, events, contentId, figure),
  });
}

/** What an upload or paste sends: the image file as picked or pasted, and where it goes. */
export interface FigureUploadInput {
  file: Blob;
  meta: FigureUploadMeta;
  signal?: AbortSignal;
}

/**
 * `POST /api/contents/:id/figures/upload` (multipart: `meta` first, then `file`), for both
 * upload and paste. The server identifies the image by its bytes; refusals are `ApiError`s
 * with `invalid_request.figure_image` (`details.reason`) or `invalid_request.figure_limit`.
 */
export function useUploadFigure(contentId: string): UseMutationResult<FigureDto, Error, FigureUploadInput> {
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  return useMutation({
    mutationFn: (input: FigureUploadInput) => uploadFigure(client, contentId, input),
    onSuccess: (figure) => afterCreate(queryClient, events, contentId, figure),
  });
}

export function uploadFigure(client: ApiClient, contentId: string, input: FigureUploadInput): Promise<FigureDto> {
  const form = new FormData();
  // The server reads `meta` before the image, so it can refuse a bad placement before the bytes arrive.
  form.append("meta", JSON.stringify(input.meta));
  form.append("file", input.file);
  return client.upload(`${figuresPath(contentId)}/upload`, form, figureDtoSchema, { idempotent: true, ...(input.signal === undefined ? {} : { signal: input.signal }) });
}

/** A stored width, or `undefined` when it is missing or not a width a figure can have. */
export function parseFigureWidth(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= FIGURE_WIDTH_MIN_RATIO && ratio <= 1 ? ratio : undefined;
}

/** The width a new figure gets: the one the user last gave a figure, else the default. */
export function rememberedFigureWidth(): number {
  try {
    return parseFigureWidth(localStorage.getItem(FIGURE_WIDTH_PREF_KEY)) ?? FIGURE_WIDTH_DEFAULT;
  } catch {
    return FIGURE_WIDTH_DEFAULT;
  }
}

/** Remembers a width the user gave a figure, for the next new one. Storage that refuses it only loses the preference. */
export function rememberFigureWidth(ratio: number): void {
  if (parseFigureWidth(String(ratio)) === undefined) return;
  try {
    localStorage.setItem(FIGURE_WIDTH_PREF_KEY, String(ratio));
  } catch {
    // Not remembered: new figures take the default.
  }
}
