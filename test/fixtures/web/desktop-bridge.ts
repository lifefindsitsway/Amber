import { vi } from "vitest";
import type { RestoreApplyReport, RestoreInspectReport } from "../../../src/shared/dto/backup.ts";
import type { FileGrant } from "../../../src/shared/dto/local-media.ts";
import type { PickedFile, UpdateDownloadEvent } from "../../../src/web/desktop/bridge.ts";

type Handler = (payload: unknown) => void;

/**
 * A stand-in desktop shell for web tests. A test file swaps the bridge for it with
 *
 *   vi.mock("<path>/src/web/desktop/bridge.ts", async (importOriginal) => ({
 *     ...(await importOriginal<object>()),
 *     ...(await import("<path>/test/fixtures/web/desktop-bridge.ts")).fakeBridge,
 *   }));
 *
 * then sets `fakeShell.desktop = true` and the command results it needs. State is reset
 * after every test (setup.ts).
 */
export const fakeShell = {
  desktop: false,
  pickLocalFile: vi.fn<(kind: "media" | "subtitle") => Promise<PickedFile | null>>(),
  pickRelinkFile: vi.fn<() => Promise<PickedFile | null>>(),
  saveBurnOutput: vi.fn<(grant: PickedFile["grant"], suggestedName: string) => Promise<{ savedPath: string } | null>>(),
  saveCachedMedia: vi.fn<(grant: PickedFile["grant"], suggestedName: string) => Promise<{ savedPath: string } | null>>(),
  openBilibiliLogin: vi.fn<() => Promise<{ cookies: string } | null>>(),
  clearBilibiliPlayerSession: vi.fn<() => Promise<void>>(),
  rotateMasterKey: vi.fn<() => Promise<void>>(),
  pickBackupDestination: vi.fn<(suggestedName: string) => Promise<PickedFile | null>>(),
  inspectBackup: vi.fn<() => Promise<{ archive: PickedFile; report: RestoreInspectReport } | null>>(),
  pickRestoreOriginalsDir: vi.fn<(localStamp: string) => Promise<PickedFile | null>>(),
  restoreBackup: vi.fn<(archiveGrant: FileGrant, originalsGrant: FileGrant | null) => Promise<RestoreApplyReport>>(),
  beginUpdateInstall: vi.fn<() => Promise<void>>(),
  endUpdateInstall: vi.fn<() => Promise<void>>(),
  updateDownload: vi.fn<(rid: number, onEvent: (event: UpdateDownloadEvent) => void) => Promise<void>>(),
  updateInstall: vi.fn<(rid: number) => Promise<void>>(),
  pickPackDestination: vi.fn<(suggestedName: string) => Promise<PickedFile | null>>(),
  pickPackSource: vi.fn<() => Promise<PickedFile | null>>(),
  pickPackOriginalsDir: vi.fn<(localStamp: string) => Promise<PickedFile | null>>(),
  listeners: new Map<string, Set<Handler>>(),
  /** Fires a shell event at every subscriber. */
  emit(event: string, payload?: unknown): void {
    for (const handler of fakeShell.listeners.get(event) ?? []) handler(payload);
  },
};

export function resetFakeShell(): void {
  fakeShell.desktop = false;
  for (const mock of [fakeShell.pickLocalFile, fakeShell.pickRelinkFile, fakeShell.saveBurnOutput, fakeShell.saveCachedMedia, fakeShell.openBilibiliLogin, fakeShell.clearBilibiliPlayerSession, fakeShell.rotateMasterKey, fakeShell.pickBackupDestination, fakeShell.inspectBackup, fakeShell.pickRestoreOriginalsDir, fakeShell.restoreBackup, fakeShell.beginUpdateInstall, fakeShell.endUpdateInstall, fakeShell.updateDownload, fakeShell.updateInstall, fakeShell.pickPackDestination, fakeShell.pickPackSource, fakeShell.pickPackOriginalsDir]) {
    mock.mockReset();
  }
  fakeShell.listeners.clear();
}

/** A picked file with a synthetic grant that expires `ttlMs` from now. */
export function pickedFile(path: string, purpose: FileGrant["purpose"] = "local_file", ttlMs = 60_000): PickedFile {
  return { path, grant: { path, purpose, expiresAt: Date.now() + ttlMs, sig: "test-signature" } };
}

export const fakeBridge = {
  isDesktop: async () => fakeShell.desktop,
  pickLocalFile: (kind: "media" | "subtitle") => fakeShell.pickLocalFile(kind),
  pickRelinkFile: () => fakeShell.pickRelinkFile(),
  saveBurnOutput: (grant: PickedFile["grant"], suggestedName: string) => fakeShell.saveBurnOutput(grant, suggestedName),
  saveCachedMedia: (grant: PickedFile["grant"], suggestedName: string) => fakeShell.saveCachedMedia(grant, suggestedName),
  openBilibiliLogin: () => fakeShell.openBilibiliLogin(),
  clearBilibiliPlayerSession: () => fakeShell.clearBilibiliPlayerSession(),
  rotateMasterKey: () => fakeShell.rotateMasterKey(),
  pickBackupDestination: (suggestedName: string) => fakeShell.pickBackupDestination(suggestedName),
  inspectBackup: () => fakeShell.inspectBackup(),
  pickRestoreOriginalsDir: (localStamp: string) => fakeShell.pickRestoreOriginalsDir(localStamp),
  restoreBackup: (archiveGrant: FileGrant, originalsGrant: FileGrant | null) => fakeShell.restoreBackup(archiveGrant, originalsGrant),
  beginUpdateInstall: () => fakeShell.beginUpdateInstall(),
  endUpdateInstall: () => fakeShell.endUpdateInstall(),
  updateDownload: (rid: number, onEvent: (event: UpdateDownloadEvent) => void) => fakeShell.updateDownload(rid, onEvent),
  updateInstall: (rid: number) => fakeShell.updateInstall(rid),
  pickPackDestination: (suggestedName: string) => fakeShell.pickPackDestination(suggestedName),
  pickPackSource: () => fakeShell.pickPackSource(),
  pickPackOriginalsDir: (localStamp: string) => fakeShell.pickPackOriginalsDir(localStamp),
  localFileUrl: async (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  onShellEvent: async <T>(event: string, handler: (payload: T) => void): Promise<() => void> => {
    const set = fakeShell.listeners.get(event) ?? new Set<Handler>();
    fakeShell.listeners.set(event, set);
    const wrapped: Handler = (payload) => handler(payload as T);
    set.add(wrapped);
    return () => set.delete(wrapped);
  },
};
