import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { UPDATE_CHECK_TIMEOUT_MS } from "../../shared/defaults.ts";
import { maintenanceDtoSchema } from "../../shared/dto/backup.ts";
import { ApiError, type ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { beginUpdateInstall, endUpdateInstall, updateDownload, updateInstall, type UpdateDownloadEvent } from "./bridge.ts";
import { checkFailure, downloadFailure, installFailure, type UpdateFailure } from "./update-failure.ts";

export type { UpdateDownloadEvent } from "./bridge.ts";
export type { UpdateFailure, UpdateFailureKind, UpdateStep } from "./update-failure.ts";

/**
 * The desktop client's update controller: one per process, shared by
 * the prompt card and the about dialog. Check, download and install never overlap; nothing
 * is downloaded before the user asks; installing first takes the sidecar's maintenance
 * admission, then registers with the shell, then hands over to the installer, which ends
 * the app on Windows. The app never relaunches itself; the installer starts the new version
 * once it has finished (the updater's default restart-after-install).
 */

export const UPDATE_STATUSES = ["idle", "checking", "up_to_date", "available", "downloading", "ready_to_install", "installing", "failed"] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

export type BackupWork = "export" | "restore";

/** Download progress: bytes held, the total once the server sent one, and a reconnect under way. */
export interface UpdateProgress {
  downloaded: number;
  total?: number;
  /** Set while the shell reconnects after a drop or a stall; the next bytes clear it. */
  retrying?: { attempt: number };
}

export interface UpdateState {
  status: UpdateStatus;
  /** The version the feed announces, once a check found one. */
  version?: string;
  /** The release notes, rendered as plain text only. */
  notes?: string;
  progress?: UpdateProgress;
  /** The failed step, what kind of failure it was, and how far a download had got. */
  error?: UpdateFailure;
  /** Why the maintenance admission was refused (`conflict.*` codes); the download stays ready to install. */
  blocked?: string[];
  /** Whether the bottom-right card shows: set by an automatic check, cleared by 「稍后」. */
  prompt: boolean;
  /** Whether the last finished check was the user's own. */
  manual: boolean;
}

/**
 * The part of a found update the controller uses (the updater plugin's `Update`). Download and
 * install go through the shell's own commands by its resource id, not the plugin's: the
 * shell's download resumes after a dropped connection.
 */
export interface UpdateHandle {
  version: string;
  body?: string | null;
  rid: number;
  close?(): Promise<void>;
}

/** What the controller talks to; replaced in tests. */
export interface UpdaterDeps {
  check(options: { timeout: number }): Promise<UpdateHandle | null>;
  /** Downloads and verifies `update`, continuing from the bytes a failed attempt kept; rejects with the shell's structured failure. */
  download(update: UpdateHandle, onEvent: (event: UpdateDownloadEvent) => void): Promise<void>;
  /** Runs the installer on the verified download; on Windows the process ends here. */
  install(update: UpdateHandle): Promise<void>;
  /** `POST /api/system/maintenance`; rejects with the sidecar's ApiError when refused. */
  requestMaintenance(): Promise<void>;
  /** `DELETE /api/system/maintenance`. */
  releaseMaintenance(): Promise<void>;
  beginUpdateInstall(): Promise<void>;
  endUpdateInstall(): Promise<void>;
}

/** Device-level preference 「启动时自动检查更新」; on unless switched off. Not carried by backups. */
export const AUTO_CHECK_KEY = "amber.updates.autoCheck";

export function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_CHECK_KEY) !== "0";
  } catch {
    return true;
  }
}

/** The maintenance admission's refusal, as the codes the install dialog explains. */
function refusalCodes(error: unknown): string[] | undefined {
  if (error instanceof ApiError && error.status === 409) {
    return [error.error.code];
  }
  return undefined;
}

/** The progress after one download event. Bytes only go back when the shell says it starts over. */
export function nextProgress(progress: UpdateProgress, event: UpdateDownloadEvent): UpdateProgress {
  const { retrying: _retrying, ...rest } = progress;
  switch (event.event) {
    case "Started":
      return event.data.contentLength === undefined ? progress : { ...progress, total: event.data.contentLength };
    case "Resumed":
      return { ...progress, downloaded: event.data.downloaded };
    case "Progress":
      return { ...rest, downloaded: progress.downloaded + event.data.chunkLength };
    case "Retrying":
      return { ...progress, retrying: { attempt: event.data.attempt } };
    case "Finished":
      return rest;
  }
}

export class UpdateController {
  private state: UpdateState = { status: "idle", prompt: false, manual: false };
  private readonly listeners = new Set<() => void>();
  private deps: UpdaterDeps | undefined;
  private update: UpdateHandle | undefined;
  private busy = false;
  /** One automatic check per process: remounts and sidecar restarts never repeat it. */
  private autoChecked = false;
  /** An automatic check asked for before the dependencies arrived; it runs once they do. */
  private autoCheckPending = false;
  /** The version the user postponed with 「稍后」, in memory only: a restart asks again. */
  private deferredVersion: string | undefined;
  /** Backup work in progress: an install waits for it, and export and restore exclude each other. */
  private readonly backupWork = new Set<BackupWork>();

  constructor(deps?: UpdaterDeps) {
    this.deps = deps;
  }

  /** Supplies the dependencies once the API client exists; earlier calls do nothing. */
  configure(deps: UpdaterDeps): void {
    this.deps = deps;
    if (this.autoCheckPending) {
      this.autoCheckPending = false;
      void this.autoCheck();
    }
  }

  isConfigured(): boolean {
    return this.deps !== undefined;
  }

  getState = (): UpdateState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Merges `next`; a key set to `undefined` is removed. */
  private set(next: { [K in keyof UpdateState]?: UpdateState[K] | undefined }): void {
    const merged: Record<string, unknown> = { ...this.state, ...next };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    this.state = merged as unknown as UpdateState;
    for (const listener of this.listeners) listener();
  }

  /** Whether a step is running; the backup section disables export and restore meanwhile. */
  isBusy(): boolean {
    return this.state.status === "downloading" || this.state.status === "installing";
  }

  setBackupBusy(work: BackupWork, busy: boolean): void {
    if (busy === this.backupWork.has(work)) return;
    if (busy) this.backupWork.add(work);
    else this.backupWork.delete(work);
    for (const listener of this.listeners) listener();
  }

  /** Whether `work` (or, without it, any backup work) is running. */
  isBackupBusy(work?: BackupWork): boolean {
    return work === undefined ? this.backupWork.size > 0 : this.backupWork.has(work);
  }

  /** The start-up check: at most once per process, and only while the preference is on. */
  async autoCheck(): Promise<void> {
    if (this.autoChecked || !autoCheckEnabled()) {
      return;
    }
    if (this.deps === undefined) {
      this.autoCheckPending = true;
      return;
    }
    this.autoChecked = true;
    await this.check({ manual: false });
  }

  /**
   * Asks the feed. A manual check shows its result in the about dialog only; an automatic one
   * raises the card for a version the user has not postponed. A failed automatic check stays
   * silent and is not a postponement.
   */
  async check(options: { manual: boolean }): Promise<void> {
    const deps = this.deps;
    if (deps === undefined || this.busy || this.isBusy() || this.state.status === "ready_to_install") {
      return;
    }
    this.busy = true;
    this.set({ status: "checking", manual: options.manual, blocked: undefined, error: undefined });
    try {
      const found = await deps.check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
      if (found === null) {
        this.update = undefined;
        this.set({ status: "up_to_date", version: undefined, notes: undefined, prompt: false });
        return;
      }
      const previous = this.update;
      this.update = found;
      if (previous !== undefined && previous !== found) void previous.close?.().catch(() => undefined);
      const prompt = options.manual ? this.state.prompt && found.version === this.state.version : found.version !== this.deferredVersion;
      // The plugin reports a release without notes as `null`.
      this.set({ status: "available", version: found.version, notes: found.body ?? undefined, prompt });
    } catch (error) {
      this.set({ status: "failed", error: checkFailure(error), prompt: false });
    } finally {
      this.busy = false;
    }
  }

  /** 「稍后」: hides the card for this version until the app restarts. */
  later(): void {
    this.deferredVersion = this.state.version;
    this.set({ prompt: false });
  }

  /**
   * Downloads and verifies the found update; installing is a separate step. A retry after a
   * failed download simply asks again: the shell kept the bytes and reports them as `Resumed`.
   */
  async download(): Promise<void> {
    const deps = this.deps;
    const update = this.update;
    if (deps === undefined || update === undefined || this.busy || (this.state.status !== "available" && !(this.state.status === "failed" && this.state.error?.step === "download"))) {
      return;
    }
    this.busy = true;
    let progress: UpdateProgress = { downloaded: 0 };
    this.set({ status: "downloading", progress, error: undefined });
    try {
      await deps.download(update, (event) => {
        progress = nextProgress(progress, event);
        this.set({ progress });
      });
      this.set({ status: "ready_to_install", progress: nextProgress(progress, { event: "Finished" }) });
    } catch (error) {
      const { retrying: _retrying, ...snapshot } = progress;
      this.set({ status: "failed", progress: snapshot, error: downloadFailure(error, snapshot) });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Maintenance admission → shell registration → installer. A refused admission keeps the
   * download ready and lists the reasons; any later failure releases both again.
   */
  async install(): Promise<void> {
    const deps = this.deps;
    const update = this.update;
    const retrying = this.state.status === "failed" && this.state.error?.step === "install";
    if (deps === undefined || update === undefined || this.busy || this.backupWork.size > 0 || (this.state.status !== "ready_to_install" && !retrying)) {
      return;
    }
    this.busy = true;
    this.set({ status: "installing", blocked: undefined, error: undefined });
    try {
      try {
        await deps.requestMaintenance();
      } catch (error) {
        const codes = refusalCodes(error);
        if (codes !== undefined) {
          this.set({ status: "ready_to_install", blocked: codes });
        } else {
          this.set({ status: "failed", error: installFailure(error) });
        }
        return;
      }
      let registered = false;
      try {
        await deps.beginUpdateInstall();
        registered = true;
        // On Windows the installer takes over and the process ends here.
        await deps.install(update);
      } catch (error) {
        if (registered) await deps.endUpdateInstall().catch(() => undefined);
        await deps.releaseMaintenance().catch(() => undefined);
        this.set({ status: "failed", error: installFailure(error) });
      }
    } finally {
      this.busy = false;
    }
  }

  /** Abandons an install the admission refused: the download stays, nothing else is held. */
  dismissBlocked(): void {
    this.set({ blocked: undefined });
  }

  /** Repeats the failed step. */
  async retry(): Promise<void> {
    const step = this.state.error?.step;
    if (this.state.status !== "failed" || step === undefined) {
      return;
    }
    if (step === "check") await this.check({ manual: this.state.manual });
    else if (step === "download") await this.download();
    else await this.install();
  }
}

/** The process-wide controller. */
export const updateController = new UpdateController();

/** The real dependencies over the updater plugin, the shell bridge and the sidecar. */
export function defaultUpdaterDeps(client: ApiClient): UpdaterDeps {
  return {
    check: async (options) => {
      const { check } = await import("@tauri-apps/plugin-updater");
      return check(options);
    },
    download: (update, onEvent) => updateDownload(update.rid, onEvent),
    install: (update) => updateInstall(update.rid),
    requestMaintenance: async () => {
      await client.post("/api/system/maintenance", maintenanceDtoSchema, { body: { reason: "update_install" } });
    },
    releaseMaintenance: async () => {
      await client.delete("/api/system/maintenance", z.undefined());
    },
    beginUpdateInstall,
    endUpdateInstall,
  };
}

const UpdaterContext = createContext<UpdateController>(updateController);

/** Wires the process-wide controller to the current API client (re-pointed in place on sidecar restarts). */
export function UpdateProvider(props: { children: ReactNode; controller?: UpdateController }) {
  const client = useApi();
  const controller = props.controller ?? updateController;
  useEffect(() => {
    if (controller === updateController || !controller.isConfigured()) controller.configure(defaultUpdaterDeps(client));
  }, [client, controller]);
  return createElement(UpdaterContext.Provider, { value: controller }, props.children);
}

export function useUpdateController(): UpdateController {
  return useContext(UpdaterContext);
}

/** The controller's state, re-rendering on every change. */
export function useUpdater(): UpdateState & { controller: UpdateController } {
  const controller = useUpdateController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  return { ...state, controller };
}

/** Whether backup work (`work`, or any) is running, re-rendering on change. */
export function useBackupBusy(work?: BackupWork): boolean {
  const controller = useUpdateController();
  return useSyncExternalStore(controller.subscribe, () => controller.isBackupBusy(work));
}
