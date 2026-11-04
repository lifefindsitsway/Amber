import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError } from "../../api/client.ts";

/** Quiet time after the last keystroke before the draft is saved. */
const AUTOSAVE_DELAY_MS = 800;

/**
 * `editing ⇄ saving` while the user works; `committing`, `discarding` and `closed` are
 * terminal: once entered, no autosave is sent any more.
 */
export type DraftPhase = "editing" | "saving" | "committing" | "discarding" | "closed";

/** What the toolbar shows about the edits. */
export type DraftSaveState = "saved" | "pending" | "saving" | "failed" | "conflict";

export interface DraftSyncSnapshot {
  phase: DraftPhase;
  save: DraftSaveState;
  /** The version of the draft the next write expects; `null` while there should be no draft yet. */
  version: number | null;
  /** Set after `conflict.draft_changed`: the draft's version on the server, `null` when it is gone. */
  conflict: { currentVersion: number | null } | undefined;
  /** Edits that are not (yet) on the server: queued, failed or refused. */
  unsaved: boolean;
}

/** Writes the whole draft, expecting `expectedVersion`; resolves with the new version. */
export type DraftSave<T> = (value: T, expectedVersion: number | null) => Promise<{ version: number }>;

/** The draft's current version when `error` is `conflict.draft_changed`. */
export function draftChangedVersion(error: unknown): { currentVersion: number | null } | undefined {
  if (!(error instanceof ApiError) || error.error.code !== "conflict.draft_changed") return undefined;
  const current = error.error.details?.["currentVersion"];
  return { currentVersion: typeof current === "number" ? current : null };
}

/**
 * Keeps one editor's draft on the server without ever racing itself:
 *
 * - at most one save is in flight; edits made meanwhile are merged into the next save;
 * - every save names the version the last successful write returned, so the server refuses a
 *   save that would overwrite another window's work or bring back a discarded draft;
 * - committing, discarding and closing first stop the autosave and wait for the save in
 *   flight, then act on the version it produced;
 * - a failed save keeps the edits in memory for a retry; a refused one (another window wrote
 *   the draft) stops autosaving until the user picks whose text wins.
 */
export class DraftSync<T> {
  private phase: DraftPhase = "editing";
  private version: number | null = null;
  private latest: T | undefined;
  private dirty = false;
  private failed = false;
  private conflict: { currentVersion: number | null } | undefined;
  private inflight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: DraftSyncSnapshot;
  private readonly listeners = new Set<() => void>();
  private attached = false;
  /** Set while closing, so no autosave starts on its own meanwhile. */
  private closing = false;

  private readonly saveDraft: DraftSave<T>;
  private readonly delayMs: number;

  constructor(saveDraft: DraftSave<T>, delayMs: number = AUTOSAVE_DELAY_MS) {
    this.saveDraft = saveDraft;
    this.delayMs = delayMs;
    this.snapshot = this.compute();
  }

  /** Starts from the loaded text and the draft's version (`null`: no draft on the server yet). */
  init(value: T, version: number | null): void {
    this.latest = value;
    this.version = version;
    this.dirty = false;
    this.failed = false;
    this.conflict = undefined;
    this.notify();
  }

  /** 「载入最新」: the server's text replaces this window's unsaved edits. */
  reset(value: T, version: number | null): void {
    if (this.isTerminal()) return;
    this.clearTimer();
    this.init(value, version);
  }

  edit(value: T): void {
    if (this.isTerminal()) return;
    this.latest = value;
    this.dirty = true;
    this.notify();
    if (this.conflict !== undefined) return;
    this.clearTimer();
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** 「重试」 after a failed save. */
  retry(): void {
    if (this.isTerminal() || this.conflict !== undefined) return;
    this.failed = false;
    this.clearTimer();
    this.flush();
  }

  /**
   * 「以本窗口为准」: this window's text overwrites the draft at the version the server reported
   * (or creates it anew when it is gone). Only on an explicit click.
   */
  overwrite(): void {
    if (this.isTerminal() || this.conflict === undefined) return;
    this.version = this.conflict.currentVersion;
    this.conflict = undefined;
    this.failed = false;
    this.dirty = true;
    this.flush();
  }

  /**
   * Saves what is still unsaved, then runs `action` (the commit) with the draft's version.
   * On failure the editor goes back to editing with nothing lost; on success it is closed.
   */
  async commit<R>(action: (version: number) => Promise<R>): Promise<R> {
    if (this.isTerminal()) throw new Error("draft editor already finished");
    if (this.conflict !== undefined) throw new Error("draft conflict unresolved");
    this.enter("committing");
    try {
      await this.settle();
      if (this.dirty || this.failed || this.version === null) {
        this.failed = false;
        await this.write();
      }
      const result = await action(this.version as number);
      this.enter("closed");
      return result;
    } catch (error) {
      this.recover(error);
      throw error;
    }
  }

  /**
   * Drops every unsaved edit and runs `action` (the delete) with the draft's version. A draft
   * that never reached the server needs no delete.
   */
  async discard(action: (version: number) => Promise<void>): Promise<void> {
    if (this.isTerminal()) return;
    this.enter("discarding");
    const wasDirty = this.dirty;
    this.dirty = false;
    try {
      await this.settle();
      if (this.version !== null) await action(this.version);
      this.enter("closed");
    } catch (error) {
      this.dirty = wasDirty || this.dirty;
      this.recover(error);
      throw error;
    }
  }

  /**
   * Closes the editor. Explicit exit drops queued edits after the user has confirmed that
   * choice; an unmount first saves a queued edit when it can do so safely, so switching Content
   * or revision before the autosave delay elapses does not silently lose the last keystrokes.
   * A save already in flight is always allowed to settle, and nothing starts after closing.
   */
  async close(savePending = false): Promise<void> {
    if (this.phase === "closed" || this.closing) return;
    this.closing = true;
    this.clearTimer();
    if (savePending && !this.isTerminal()) {
      // Let a save in flight finish first: the last edit then goes out at the version it returned.
      await this.settle();
      if (this.dirty && !this.failed && this.conflict === undefined && this.latest !== undefined) {
        await this.write().catch(() => undefined);
      }
    }
    this.dirty = false;
    this.failed = false;
    this.conflict = undefined;
    this.enter("closed");
    await this.settle();
  }

  /** For React: mounting (again, under StrictMode) keeps the editor open. */
  attach(): void {
    this.attached = true;
  }

  /** For React: an unmount that is not followed by a StrictMode remount saves queued edits, then closes. */
  detach(): void {
    this.attached = false;
    queueMicrotask(() => {
      if (!this.attached) void this.close(true);
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DraftSyncSnapshot => this.snapshot;

  private isTerminal(): boolean {
    return this.phase === "committing" || this.phase === "discarding" || this.phase === "closed";
  }

  private enter(phase: DraftPhase): void {
    this.phase = phase;
    this.clearTimer();
    this.notify();
  }

  /** After a failed commit or discard: back to editing, with a refusal shown as a conflict. */
  private recover(error: unknown): void {
    const changed = draftChangedVersion(error);
    if (changed !== undefined) this.conflict = changed;
    if (this.phase !== "closed") this.phase = "editing";
    this.notify();
  }

  private async settle(): Promise<void> {
    while (this.inflight !== undefined) await this.inflight;
  }

  /** One save of the latest text; the only place a save is sent, so they never overlap. */
  private write(): Promise<void> {
    const value = this.latest as T;
    this.dirty = false;
    const request = this.saveDraft(value, this.version).then(
      (result) => {
        this.version = result.version;
        this.failed = false;
      },
      (error: unknown) => {
        this.dirty = true;
        const changed = draftChangedVersion(error);
        if (changed !== undefined) this.conflict = changed;
        else this.failed = true;
        throw error;
      },
    );
    const tracked = request.then(
      () => undefined,
      () => undefined,
    );
    this.inflight = tracked;
    void tracked.then(() => {
      if (this.inflight === tracked) this.inflight = undefined;
      if (this.phase === "saving") this.phase = "editing";
      this.notify();
      // Edits made while that save was out go next, right away: they already waited.
      if (this.phase === "editing" && this.dirty && !this.failed && this.conflict === undefined) this.flush();
    });
    this.notify();
    return request;
  }

  private flush(): void {
    this.timer = undefined;
    if (this.phase !== "editing" || this.closing || this.inflight !== undefined || !this.dirty || this.conflict !== undefined || this.latest === undefined) return;
    this.phase = "saving";
    this.write().catch(() => undefined);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private compute(): DraftSyncSnapshot {
    const save: DraftSaveState =
      this.conflict !== undefined ? "conflict" : this.failed ? "failed" : this.inflight !== undefined ? "saving" : this.dirty ? "pending" : "saved";
    return {
      phase: this.phase,
      save,
      version: this.version,
      conflict: this.conflict,
      unsaved: this.dirty || this.failed || this.conflict !== undefined,
    };
  }

  private notify(): void {
    this.snapshot = this.compute();
    for (const listener of this.listeners) listener();
  }
}

/**
 * One editor's `DraftSync`, closed (keeping the last edits) when the editor unmounts: leaving
 * the page, switching Content or switching version all take this one path. `save` may change
 * between renders; the latest one is used.
 */
export function useDraftSync<T>(save: DraftSave<T>): { sync: DraftSync<T>; state: DraftSyncSnapshot } {
  const latestSave = useRef(save);
  latestSave.current = save;
  const [sync] = useState(() => new DraftSync<T>((value, expected) => latestSave.current(value, expected)));
  useEffect(() => {
    sync.attach();
    return () => sync.detach();
  }, [sync]);
  const state = useSyncExternalStore(sync.subscribe, sync.getSnapshot);
  return { sync, state };
}
