import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLLECTION_PREVIEW_PER_USER_MAX, IMPORT_BATCH_MAX } from "../../../shared/defaults.ts";
import { inspectResponseSchema, type InspectRequest } from "../../../shared/dto/import.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { appErrorOf } from "../confirm-dialog.tsx";
import {
  emptySession,
  missingChoice,
  movedToFront,
  platformOrder,
  processingOrder,
  pruneChoice,
  setChosen,
  withDefaults,
  withFirstPage,
  withOrder,
  withPage,
  withPreselect,
  type CollectionChoice,
  type EntryPreselect,
  type PreviewSession,
} from "./state.ts";

function aborted(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === "AbortError";
}

function stale(caught: unknown): boolean {
  return caught instanceof ApiError && caught.error.code === "conflict.collection_preview_stale";
}

/**
 * How many times one read of a collection starts over when its preview goes stale while paging
 * on to the chosen entries. The server keeps only a few previews per user, so links read at the
 * same time can push each other's out; past this the read fails and offers 「重试」.
 */
const STALE_REREADS = 1;

/** The controller of the collection preview dialog; see `useCollectionPreview`. */
export interface CollectionPreview {
  isOpen: boolean;
  /** The collection links under preview, in the order of the input. */
  urls: readonly string[];
  step: number;
  sessions: Readonly<Record<string, PreviewSession>>;
  /** Chosen entries across all the links. */
  totalChosen: number;
  /**
   * Opens on these links (keeping what was read and chosen for links seen before), at `startUrl`
   * or the first. `preselect` gives a link opened from one of its videos that video alone as its
   * default choice, in place of every entry not yet in the collection.
   */
  open: (urls: readonly string[], startUrl?: string, preselect?: Readonly<Record<string, EntryPreselect>>) => void;
  /** Closes and stops every read in flight; the choice stays for the next opening. */
  close: () => void;
  /**
   * Forgets what was read and chosen for these links (all when none are given), once an import
   * of them was answered: the next opening reads them afresh, with their new states and defaults.
   */
  reset: (urls?: readonly string[]) => void;
  setStep: (step: number) => void;
  /** Reads every opened link from scratch, keeping the chosen entries that are still there. */
  reread: () => void;
  /** Reads a link's first page again, without its preview id. */
  retry: (url: string) => void;
  loadMore: (url: string) => Promise<boolean>;
  loadAll: (url: string) => void;
  stopLoading: (url: string) => void;
  choose: (url: string, ids: readonly string[], on: boolean) => void;
  arrange: (url: string, order: readonly string[]) => void;
  moveToFront: (url: string, id: string) => void;
  resetOrder: (url: string) => void;
  /** The links with at least one chosen entry, in input order, each in its processing order. */
  choices: () => CollectionChoice[];
}

/**
 * State and reads of the collection preview, held by the page that opens it so that closing the
 * dialog (「取消」) keeps the choice and a failed import can send the dialog back to work.
 * `compareCollectionId` is the local collection the entry states are judged against (the batch
 * add dialog's own); `reserved` counts the other links of the same import, which share the batch
 * limit. Reads go through the page's `/api` client and stop when the dialog closes.
 *
 * Each link's first page is read with at most `COLLECTION_PREVIEW_PER_USER_MAX` such reads at a
 * time, since the server keeps that many previews per user and a newer one pushes out the
 * oldest. The defaults are given in input order once a link's first page and every earlier
 * link's are in, so the same links always start with the same choice whichever answer comes first.
 */
export function useCollectionPreview(
  options: {
    compareCollectionId?: string | undefined;
    reserved?: number | undefined;
  } = {},
): CollectionPreview {
  const api = useApi();
  const store = useRef<Record<string, PreviewSession>>({});
  const [sessions, setSessions] = useState<Record<string, PreviewSession>>({});
  const [urls, setUrls] = useState<readonly string[]>([]);
  const urlsRef = useRef<readonly string[]>([]);
  // Links whose first page is in, waiting for the earlier links' before their defaults are given.
  const pending = useRef(new Set<string>());
  // Links opened from one of their videos: the default choice is that video.
  const preselects = useRef(new Map<string, EntryPreselect>());
  const slots = useRef<{ busy: number; queue: Array<() => void> }>({ busy: 0, queue: [] });
  const [isOpen, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const controllers = useRef(new Map<string, AbortController>());
  // The room the defaults may fill: the batch limit less the other links of the import.
  const limitRef = useRef(0);
  limitRef.current = Math.max(0, IMPORT_BATCH_MAX - (options.reserved ?? 0));
  const compareRef = useRef(options.compareCollectionId);
  compareRef.current = options.compareCollectionId;

  const put = useCallback((url: string, change: (session: PreviewSession) => PreviewSession): void => {
    const current = store.current[url];
    if (current === undefined) return;
    store.current = { ...store.current, [url]: change(current) };
    setSessions(store.current);
  }, []);

  const abort = useCallback((url: string): void => {
    controllers.current.get(url)?.abort();
    controllers.current.delete(url);
  }, []);

  const inspect = useCallback(
    (url: string, page: { previewId: string; offset: number } | undefined, signal: AbortSignal) => {
      const compare = compareRef.current;
      const body: InspectRequest = {
        url,
        ...(compare === undefined ? {} : { collectionId: compare }),
        ...(page ?? {}),
      };
      return api.post("/api/contents/inspect", inspectResponseSchema, {
        body,
        signal,
      });
    },
    [api],
  );

  /** Waits for one of the first-page reads allowed at a time; a stopped read stops waiting. */
  const acquire = useCallback(
    (signal: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        const held = slots.current;
        if (held.busy < COLLECTION_PREVIEW_PER_USER_MAX) {
          held.busy += 1;
          resolve();
          return;
        }
        const grant = (): void => {
          signal.removeEventListener("abort", stop);
          resolve();
        };
        const stop = (): void => {
          held.queue = held.queue.filter((waiting) => waiting !== grant);
          reject(new DOMException("aborted", "AbortError"));
        };
        held.queue.push(grant);
        signal.addEventListener("abort", stop, { once: true });
      }),
    [],
  );

  /** Hands the slot to the next waiting read, if any. */
  const release = useCallback((): void => {
    const held = slots.current;
    const next = held.queue.shift();
    if (next === undefined) held.busy -= 1;
    else next();
  }, []);

  /**
   * Gives the waiting links their defaults in input order, each from the room the others' chosen
   * entries leave. A link not read yet holds back the ones after it; a failed one does not.
   */
  const settle = useCallback((): void => {
    for (const url of urlsRef.current) {
      const session = store.current[url];
      if (session === undefined) continue;
      if (pending.current.has(url)) {
        pending.current.delete(url);
        const others = Object.values(store.current)
          .filter((other) => other.url !== url)
          .reduce((sum, other) => sum + other.selected.size, 0);
        const preselect = preselects.current.get(url);
        put(url, (current) => ({
          ...(preselect === undefined ? withDefaults(current, limitRef.current - others) : withPreselect(current, preselect)),
          phase: "ready",
        }));
        continue;
      }
      if (session.chosen || session.phase === "failed") continue;
      break;
    }
  }, [put]);

  const loadFirst = useCallback(
    async (url: string): Promise<void> => {
      abort(url);
      pending.current.delete(url);
      const controller = new AbortController();
      controllers.current.set(url, controller);
      put(url, (session) => {
        const { error: _error, pageError: _pageError, ...rest } = session;
        return { ...rest, phase: "loading", paging: false, loadingAll: false };
      });
      let held = false;
      try {
        await acquire(controller.signal);
        held = true;
        for (let attempt = 0; ; attempt += 1) {
          try {
            const first = await inspect(url, undefined, controller.signal);
            put(url, (session) => withFirstPage(session, first));
            // Read again after the preview went stale: page on until every chosen entry is seen,
            // so that only those really gone are dropped.
            for (;;) {
              const session = store.current[url];
              if (session === undefined || session.nextOffset === undefined || session.previewId === undefined) break;
              if (!missingChoice(session)) break;
              const page = await inspect(url, { previewId: session.previewId, offset: session.nextOffset }, controller.signal);
              put(url, (current) => withPage(current, page));
            }
            break;
          } catch (caught) {
            // Pushed out while paging on: start over, the choice kept by video id.
            if (!stale(caught) || attempt >= STALE_REREADS) throw caught;
          }
        }
        if (store.current[url]?.chosen === true) {
          put(url, (session) => ({ ...pruneChoice(session), phase: "ready" }));
        } else {
          pending.current.add(url);
        }
        settle();
      } catch (caught) {
        if (aborted(caught)) return;
        put(url, (session) => ({
          ...session,
          phase: "failed",
          error: appErrorOf(caught),
        }));
        settle();
      } finally {
        if (held) release();
        if (controllers.current.get(url) === controller) controllers.current.delete(url);
      }
    },
    [abort, acquire, inspect, put, release, settle],
  );

  const loadMore = useCallback(
    async (url: string): Promise<boolean> => {
      const session = store.current[url];
      if (session === undefined || session.phase !== "ready" || session.paging || session.nextOffset === undefined || session.previewId === undefined) return false;
      const page = { previewId: session.previewId, offset: session.nextOffset };
      const controller = new AbortController();
      controllers.current.set(url, controller);
      put(url, (current) => {
        const { pageError: _pageError, ...rest } = current;
        return { ...rest, paging: true };
      });
      try {
        const answer = await inspect(url, page, controller.signal);
        put(url, (current) => ({
          ...withPage(current, answer),
          paging: false,
        }));
        return true;
      } catch (caught) {
        if (aborted(caught)) {
          put(url, (current) => ({ ...current, paging: false }));
          return false;
        }
        if (stale(caught)) {
          void loadFirst(url);
          return false;
        }
        put(url, (current) => ({
          ...current,
          paging: false,
          loadingAll: false,
          pageError: appErrorOf(caught),
        }));
        return false;
      } finally {
        if (controllers.current.get(url) === controller) controllers.current.delete(url);
      }
    },
    [inspect, loadFirst, put],
  );

  const loadAll = useCallback(
    (url: string): void => {
      put(url, (session) => ({ ...session, loadingAll: true }));
      void (async () => {
        while (store.current[url]?.loadingAll === true && (await loadMore(url))) {
          // One page at a time until the end, or until stopped.
        }
        put(url, (session) => ({ ...session, loadingAll: false }));
      })();
    },
    [loadMore, put],
  );

  const stopLoading = useCallback(
    (url: string): void => {
      put(url, (session) => ({ ...session, loadingAll: false }));
      abort(url);
    },
    [abort, put],
  );

  const open = useCallback((next: readonly string[], startUrl?: string, preselect?: Readonly<Record<string, EntryPreselect>>): void => {
    for (const [url, entry] of Object.entries(preselect ?? {})) preselects.current.set(url, entry);
    const kept: Record<string, PreviewSession> = {};
    for (const url of next) kept[url] = store.current[url] ?? emptySession(url);
    store.current = kept;
    setSessions(kept);
    urlsRef.current = [...next];
    setUrls([...next]);
    const start = startUrl === undefined ? -1 : next.indexOf(startUrl);
    setStep(start === -1 ? 0 : start);
    setOpen(true);
  }, []);

  const close = useCallback((): void => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    pending.current.clear();
    for (const url of Object.keys(store.current)) {
      put(url, (session) => ({
        ...session,
        phase: session.phase === "loading" ? "idle" : session.phase,
        paging: false,
        loadingAll: false,
      }));
    }
    setOpen(false);
  }, [put]);

  const reset = useCallback(
    (links?: readonly string[]): void => {
      const kept = { ...store.current };
      for (const url of links ?? Object.keys(kept)) {
        abort(url);
        pending.current.delete(url);
        preselects.current.delete(url);
        delete kept[url];
      }
      store.current = kept;
      setSessions(kept);
    },
    [abort],
  );

  // Every link of an open dialog is read, not just the one on screen: the limit is shared, so the last step needs all of them.
  useEffect(() => {
    if (!isOpen) return;
    for (const url of urls) {
      if (store.current[url]?.phase === "idle") void loadFirst(url);
    }
  }, [isOpen, urls, loadFirst]);

  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);

  const reread = useCallback((): void => {
    for (const url of Object.keys(store.current)) {
      if (store.current[url]?.phase !== "idle") void loadFirst(url);
    }
  }, [loadFirst]);

  const totalChosen = urls.reduce((sum, url) => sum + (sessions[url]?.selected.size ?? 0), 0);

  return useMemo(
    () => ({
      isOpen,
      urls,
      step: Math.min(step, Math.max(0, urls.length - 1)),
      sessions,
      totalChosen,
      open,
      close,
      reset,
      setStep,
      reread,
      retry: (url: string) => void loadFirst(url),
      loadMore,
      loadAll,
      stopLoading,
      choose: (url: string, ids: readonly string[], on: boolean) => put(url, (session) => setChosen(session, ids, on)),
      arrange: (url: string, order: readonly string[]) => put(url, (session) => withOrder(session, order)),
      moveToFront: (url: string, id: string) => put(url, (session) => movedToFront(session, id)),
      resetOrder: (url: string) => put(url, platformOrder),
      choices: () =>
        urls.flatMap((url) => {
          const session = store.current[url];
          if (session === undefined || session.selected.size === 0) return [];
          return [
            {
              url,
              entries: processingOrder(session),
              ...(session.previewId === undefined ? {} : { previewId: session.previewId }),
            },
          ];
        }),
    }),
    [isOpen, urls, step, sessions, totalChosen, open, close, reset, reread, loadFirst, loadMore, loadAll, stopLoading, put],
  );
}
