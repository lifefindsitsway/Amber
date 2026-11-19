import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { FigureAnchorSide, FigurePlacement } from "../../../shared/dto/figure.ts";

/**
 * Where a new figure goes, fixed at the moment the user opened the insert menu, pressed paste
 * or captured a frame: later playback or scrolling never moves it. `placement` is what the
 * create request sends.
 */
export interface FigureInsertTarget {
  revisionId: string;
  segmentId: string;
  side: FigureAnchorSide;
  placement: FigurePlacement;
}

/**
 * What the reading view offers the rest of the content page about figures. The reading view
 * registers it while it shows a transcript; the player's capture button, the insert menu, the
 * paste handler and search links use it. `undefined` from `useReaderFigures` = no reading view
 * (another tab, or no transcript), so inserting is unavailable.
 */
export interface ReaderFigureApi {
  contentId: string;
  /** The revision on screen. */
  revisionId: string;
  /** The paragraph an upload or paste goes after: the selection's, else the one being followed, else the first visible. */
  captureTarget(): FigureInsertTarget | undefined;
  /** Where a frame captured at `atMs` goes: after the paragraph holding that time. */
  targetForTime(atMs: number): FigureInsertTarget | undefined;
  /** After a figure was created or restored: scroll it into view (mounting it first) and highlight it briefly. */
  revealFigure(figureId: string): void;
}

/** A tiny store the content page owns, so the player above the reading view can reach it. */
class ReaderFigureStore {
  private api: ReaderFigureApi | undefined;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): ReaderFigureApi | undefined => this.api;

  set(api: ReaderFigureApi | undefined): void {
    if (this.api === api) return;
    this.api = api;
    for (const listener of this.listeners) listener();
  }
}

const ReaderFigureStoreContext = createContext<ReaderFigureStore | null>(null);

/** Put once around the content page; the reading view registers into it, the player reads from it. */
export function ReaderFigureProvider(props: { children: ReactNode }): ReactNode {
  const store = useMemo(() => new ReaderFigureStore(), []);
  return createElement(ReaderFigureStoreContext.Provider, { value: store }, props.children);
}

/** The reading view's figure API, or `undefined` when no reading view offers one. */
export function useReaderFigures(): ReaderFigureApi | undefined {
  const store = useContext(ReaderFigureStoreContext);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? noSnapshot);
}

/** The reading view calls this with its API (memoized), or `undefined` while it cannot take figures. */
export function useRegisterReaderFigures(api: ReaderFigureApi | undefined): void {
  const store = useContext(ReaderFigureStoreContext);
  useEffect(() => {
    if (store === null) return undefined;
    store.set(api);
    return () => store.set(undefined);
  }, [store, api]);
}

const noSubscribe = (): (() => void) => () => undefined;
const noSnapshot = (): undefined => undefined;
