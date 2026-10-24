import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { TarBackupArchiveWriter } from "../../../src/server/adapters/backup/archive-writer.ts";
import { StagedDatabase } from "../../../src/server/adapters/sqlite/restore-store.ts";
import { MediaAssetService } from "../../../src/server/application/media-assets.ts";
import { NoteService } from "../../../src/server/application/notes.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { BackupArchiveRequest, BackupArchiveWriter } from "../../../src/server/ports/backup.ts";
import { backupHeaderSchema } from "../../../src/shared/backup.ts";
import { BACKUP_HEADER_MAX_BYTES } from "../../../src/shared/defaults.ts";
import type { BackupExportRequest } from "../../../src/shared/dto/backup.ts";
import { createExportStack, readArchive, seedLibrary, settled, sha256Of } from "../../fixtures/backup/library.ts";
import { createHarness, createLocalContent, createTaskOfKind, gate, LOCAL, stageStatuses, taskOf, waitFor, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows, tableNames } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  return undefined;
}

/** A writer that stops before writing until `release` opens, recording what it was asked to write. */
function pausedWriter(before?: (request: BackupArchiveRequest) => void): BackupArchiveWriter & { requests: BackupArchiveRequest[]; started: Promise<void>; open: () => void } {
  const entered = gate();
  const proceed = gate();
  const real = new TarBackupArchiveWriter();
  const writer = {
    requests: [] as BackupArchiveRequest[],
    started: entered.promise,
    open: proceed.open,
    async write(request: BackupArchiveRequest) {
      writer.requests.push(request);
      entered.open();
      await Promise.race([proceed.promise, new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)))]);
      before?.(request);
      return real.write(request);
    },
  };
  return writer;
}

async function setup(options: Parameters<typeof createExportStack>[1] = {}) {
  const h = createHarness();
  open.push(h);
  const library = await seedLibrary(h);
  const stack = createExportStack(h, options);
  const target = join(stack.destinationDir, "我的备份.amberbackup");
  const request = (overrides: Partial<BackupExportRequest> = {}): BackupExportRequest => ({
    grant: stack.grant(target),
    includeOriginals: true,
    includeCache: true,
    ...overrides,
  });
  return { h, library, stack, target, request };
}

function liveCounts(h: Harness): Record<string, number> {
  return Object.fromEntries(
    tableNames(h.db)
      .filter((name) => !name.startsWith("sqlite_") && !name.includes("search"))
      .map((name) => [name, countRows(h.db, name)]),
  );
}

describe("BackupExportService", () => {
  it("exports right after a Task finished and before the janitor ran: archive complete, sources and live database untouched", async () => {
    const { h, library, stack, target, request } = await setup();
    const before = liveCounts(h);
    const audioPath = join(h.dir, library.audio.ref);
    const accepted = stack.service.start(
      request({ uiPreferences: { "amber.player.volume": "0.5", "amber.sidebar.width": "300" } }),
    );
    expect(accepted.preferencesDropped).toEqual([{ key: "amber.sidebar.width", reason: "not_allowed" }]);
    expect(stack.service.active()).toBe(true);
    const job = await settled(stack, accepted.jobId);
    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({ originals: 1, cache: 1, preferencesDropped: accepted.preferencesDropped });
    expect(job.result?.sizeBytes).toBe(readFileSync(target).length);
    expect(job.bytesDone).toBe(job.bytesTotal);

    const entries = await readArchive(target);
    expect(entries[0]?.path).toBe("header.json");
    expect(entries[0]?.bytes.length).toBeLessThanOrEqual(BACKUP_HEADER_MAX_BYTES);
    expect(entries.at(-1)?.path).toBe("manifest.json");
    const header = backupHeaderSchema.parse(JSON.parse(entries[0]?.bytes.toString("utf8") ?? ""));
    expect(header.includes).toEqual({ originals: true, cache: true });
    expect(header.uiPreferences).toEqual({ "amber.player.volume": "0.5" });
    expect(header.originals).toEqual([
      {
        assetId: library.original.assetId,
        archivePath: `originals/${library.original.assetId}.mp4`,
        originalName: "第一讲 录像.mp4",
        sizeBytes: library.original.bytes.length,
        fingerprint: `sha256:${sha256Of(library.original.bytes)}`,
      },
    ]);
    expect(header.cache).toEqual([{ assetId: library.cache.assetId, archivePath: "media/第一讲.mp4" }]);
    expect(header.counts).toMatchObject({ contents: 1, collections: 1, notes: 1, originals: 1, cache: 1 });
    expect(entries.find((entry) => entry.path === header.originals[0]?.archivePath)?.bytes.equals(library.original.bytes)).toBe(true);
    expect(entries.find((entry) => entry.path === "media/第一讲.mp4")?.bytes.equals(library.cache.bytes)).toBe(true);

    const snapshotFile = join(stack.destinationDir, "check.sqlite");
    writeFileSync(snapshotFile, entries.find((entry) => entry.path === "database.sqlite")?.bytes ?? Buffer.alloc(0));
    const snapshot = new Database(snapshotFile, { readonly: true });
    try {
      expect(countRows(snapshot, "secret")).toBe(0);
      expect(countRows(snapshot, "platform_account")).toBe(0);
      expect(countRows(snapshot, "media_asset", "kind = 'extracted_audio'")).toBe(0);
      expect(countRows(snapshot, "media_asset", "kind = 'external_local' AND availability = 'available'")).toBe(1);
    } finally {
      snapshot.close();
    }

    // Nothing of the live side changed: rows, the extracted audio the janitor has yet to remove, the original.
    expect(liveCounts(h)).toEqual(before);
    expect(readFileSync(audioPath, "utf8")).toBe("audio");
    expect(readFileSync(library.original.path).equals(library.original.bytes)).toBe(true);
    expect(h.gate.exclusiveReason()).toBeUndefined();
    expect(stack.service.active()).toBe(false);
    expect(readdirSync(stack.exportDir)).toEqual([]);
  });

  it("refuses to start while the start-up sweep runs, another export runs, or the cache gate is held", async () => {
    const writer = pausedWriter();
    const { h, stack, request } = await setup({ writer });
    stack.ready.value = false;
    expect(await codeOf(() => stack.service.start(request()))).toBe("conflict.starting_up");
    stack.ready.value = true;

    for (const [reason, code] of [
      ["cache_migration", "conflict.cache_migrating"],
      ["update_install", "conflict.maintenance"],
    ] as const) {
      const release = h.gate.tryExclusive(reason) as () => void;
      expect(await codeOf(() => stack.service.start(request()))).toBe(code);
      release();
    }
    const shared = h.gate.tryShared() as () => void;
    expect(await codeOf(() => stack.service.start(request()))).toBe("conflict.tasks_still_running");
    shared();

    const { jobId } = stack.service.start(request());
    await writer.started;
    const other = join(stack.destinationDir, "另一个.amberbackup");
    expect(await codeOf(() => stack.service.start(request({ grant: stack.grant(other) })))).toBe("conflict.backup_in_progress");
    writer.open();
    expect((await settled(stack, jobId)).status).toBe("succeeded");
  });

  it("refuses while a Task is unfinished or a chat answer streams, and gives the lease back", async () => {
    let inflight = false;
    const { h, library, stack, request } = await setup({ chat: { hasAnyInflight: () => inflight } });
    const taskId = createTaskOfKind(h, "process_content", {}, { contentId: library.contentId });
    expect(await codeOf(() => stack.service.start(request()))).toBe("conflict.tasks_unfinished");
    expect(h.gate.exclusiveReason()).toBeUndefined();
    h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, taskId, "cancelled", 3));
    inflight = true;
    expect(await codeOf(() => stack.service.start(request()))).toBe("conflict.chat_inflight");
    expect(h.gate.exclusiveReason()).toBeUndefined();
  });

  it("checks the destination grant, the file and its partial twin before taking anything", async () => {
    const { h, stack, target, request } = await setup();
    expect(await codeOf(() => stack.service.start(request({ grant: stack.grant(target, "local_file") })))).toBe("unauthenticated.file_grant");
    expect(await codeOf(() => stack.service.start(request({ grant: { ...stack.grant(target), sig: "forged" } })))).toBe("unauthenticated.file_grant");
    expect(await codeOf(() => stack.service.start(request({ grant: stack.grant(target, "backup_output", Date.now() - 1) })))).toBe("unauthenticated.file_grant");
    const text = join(stack.destinationDir, "x.txt");
    expect(await codeOf(() => stack.service.start(request({ grant: stack.grant(text) })))).toBe("invalid_request");
    const link = join(stack.destinationDir, "link.amberbackup");
    writeFileSync(join(stack.destinationDir, "real"), "");
    symlinkSync(join(stack.destinationDir, "real"), link);
    expect(await codeOf(() => stack.service.start(request({ grant: stack.grant(link) })))).toBe("invalid_request");
    writeFileSync(`${target}.partial`, "busy");
    expect(await codeOf(() => stack.service.start(request()))).toBe("conflict.backup_in_progress");
    expect(readFileSync(`${target}.partial`, "utf8")).toBe("busy");
    expect(h.gate.exclusiveReason()).toBeUndefined();
  });

  it("fails disk_low without enough space and media_changed for an unreadable original unless it is excluded", async () => {
    let free = 0;
    const { h, library, stack, target, request } = await setup({ freeBytes: () => free });
    expect(await codeOf(() => stack.service.start(request()))).toBe("disk_low");
    free = Number.MAX_SAFE_INTEGER;
    // Moved away by the user: unreadable at admission.
    rmSync(library.original.path);
    expect(await codeOf(() => stack.service.start(request()))).toBe("media_changed");
    expect(h.gate.exclusiveReason()).toBeUndefined();

    const estimate = stack.service.estimate({ includeOriginals: true, includeCache: false });
    expect(estimate.originals.unreadable).toEqual([{ assetId: library.original.assetId, displayName: "第一讲 录像.mp4", reason: "missing" }]);
    expect(estimate.cache).toEqual({ count: 0, bytes: 0 });

    const { jobId } = stack.service.start(request({ excludeOriginals: [library.original.assetId] }));
    expect((await settled(stack, jobId)).status).toBe("succeeded");
    const entries = await readArchive(target);
    const header = backupHeaderSchema.parse(JSON.parse(entries[0]?.bytes.toString("utf8") ?? ""));
    expect(header.excludedOriginals).toEqual([library.original.assetId]);
    expect(header.originals).toEqual([]);
    expect(entries.some((entry) => entry.path.startsWith("originals/"))).toBe(false);
  });

  it("fails media_changed when an original changes during the copy, naming it and leaving no archive", async () => {
    let path = "";
    const writer = pausedWriter(() => writeFileSync(path, randomBytes(4096)));
    const { library, stack, target, request } = await setup({ writer });
    path = library.original.path;
    const { jobId } = stack.service.start(request());
    writer.open();
    const job = await settled(stack, jobId);
    expect(job.status).toBe("failed");
    expect(job.error?.class).toBe("media_changed");
    expect(job.failedAsset).toEqual({ assetId: library.original.assetId, displayName: "第一讲 录像.mp4" });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.partial`)).toBe(false);
  });

  it("holds deletions, cache removal and new Task drivers off while it runs; notes still save but stay out of the snapshot", async () => {
    const writer = pausedWriter();
    const { h, library, stack, request } = await setup({ writer });
    h.scheduler.start();
    const { jobId } = stack.service.start(request());
    await writer.started;

    // Notes and other database writes go on; the snapshot was taken at admission.
    const second = library.fixture.corrected.segments[1];
    if (second === undefined) throw new Error("fixture has no second segment");
    new NoteService({ repository: h.repository, newId: h.newId }).create(LOCAL, library.contentId, {
      transcriptRevisionId: library.fixture.corrected.revision.id,
      startSegmentId: second.id,
      startOffset: 0,
      endSegmentId: second.id,
      endOffset: 1,
      mark: "underline",
      color: "blue",
    });
    expect(countRows(h.db, "note")).toBe(2);
    const snapshot = new Database(writer.requests[0]?.databasePath ?? "", { readonly: true });
    expect(countRows(snapshot, "note")).toBe(1);
    snapshot.close();

    // Anything that would remove a cache file is turned away or deferred.
    const media = new MediaAssetService({ repository: h.repository, media: h.media, gate: h.gate });
    expect(await codeOf(() => media.delete(LOCAL, library.cache.assetId))).toBe("conflict.backup_in_progress");
    const doomed = createLocalContent(h);
    h.trash.trash(LOCAL, doomed);
    expect(await codeOf(() => h.deleteContent.purge(LOCAL.userId, doomed, { onlyTrashed: true }))).toBe("conflict.backup_in_progress");
    expect(h.gate.tryExclusive("cache_migration")).toBeUndefined();
    h.repository.withTransaction((scope) =>
      h.fileDeleter.register(scope, [{ store: "cache", storageRef: library.cache.ref, expectedSizeBytes: library.cache.bytes.length }]),
    );
    h.fileDeleter.kick();
    await h.fileDeleter.whenIdle();
    expect(existsSync(h.media.cache.pathOf(library.cache.ref))).toBe(true);
    expect(countRows(h.db, "pending_file_delete")).toBe(1);

    // A new Task is accepted but waits for the lease.
    const queued = createTaskOfKind(h, "process_content", {}, { contentId: library.contentId });
    const queuedStatuses = stageStatuses(h, queued);
    h.scheduler.kick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stageStatuses(h, queued)).toEqual(queuedStatuses);
    expect(taskOf(h, queued).statusProjection).toBe("queued");

    writer.open();
    expect((await settled(stack, jobId)).status).toBe("succeeded");
    // Once the lease is back the queued Task's driver runs.
    h.scheduler.kick();
    await waitFor(() => stageStatuses(h, queued)["media"] === "succeeded");
  });

  it("cancels a running job: no archive, no partial file, lease and staging released", async () => {
    const writer = pausedWriter();
    const { h, stack, target, request } = await setup({ writer });
    const { jobId } = stack.service.start(request());
    await writer.started;
    const job = await stack.service.cancel(jobId);
    expect(job.status).toBe("cancelled");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(h.gate.exclusiveReason()).toBeUndefined();
    expect(readdirSync(stack.exportDir)).toEqual([]);
    expect(await codeOf(() => stack.service.get("unknown"))).toBe("not_found");
  });

  it("removes at start-up only the partial archives its records name that are regular files written after the job started", async () => {
    const { stack } = await setup();
    mkdirSync(stack.exportDir, { recursive: true });
    const now = Date.now();
    const record = (jobId: string, target: string, startedAt = now): void =>
      writeFileSync(join(stack.exportDir, `${jobId}.json`), JSON.stringify({ jobId, target, startedAt }));
    const fresh = join(stack.destinationDir, "a.amberbackup");
    writeFileSync(`${fresh}.partial`, "x");
    record("01A", fresh, now - 10_000);
    const old = join(stack.destinationDir, "b.amberbackup");
    writeFileSync(`${old}.partial`, "user file");
    utimesSync(`${old}.partial`, new Date(now - 3_600_000), new Date(now - 3_600_000));
    record("01B", old);
    const directory = join(stack.destinationDir, "c.amberbackup");
    mkdirSync(`${directory}.partial`);
    record("01C", directory, 0);
    const unrecorded = join(stack.destinationDir, "d.amberbackup.partial");
    writeFileSync(unrecorded, "x");
    mkdirSync(join(stack.exportDir, "01A"));
    writeFileSync(join(stack.exportDir, "01A", "database.sqlite"), "x");

    stack.service.sweepLeftovers();
    expect(existsSync(`${fresh}.partial`)).toBe(false);
    expect(readFileSync(`${old}.partial`, "utf8")).toBe("user file");
    expect(existsSync(`${directory}.partial`)).toBe(true);
    expect(existsSync(unrecorded)).toBe(true);
    expect(readdirSync(stack.exportDir)).toEqual([]);
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("exports originals %s and cache %s: the archive carries exactly that, the snapshot marks the rest", async (includeOriginals, includeCache) => {
    const { library, stack, target, request } = await setup();
    const { jobId } = stack.service.start(request({ includeOriginals, includeCache }));
    expect((await settled(stack, jobId)).status).toBe("succeeded");
    const entries = await readArchive(target);
    const header = backupHeaderSchema.parse(JSON.parse(entries[0]?.bytes.toString("utf8") ?? ""));
    expect(header.includes).toEqual({ originals: includeOriginals, cache: includeCache });
    expect(header.originals.length).toBe(includeOriginals ? 1 : 0);
    expect(header.cache.length).toBe(includeCache ? 1 : 0);
    expect(entries.some((entry) => entry.path.startsWith("originals/"))).toBe(includeOriginals);
    expect(entries.some((entry) => entry.path.startsWith("media/"))).toBe(includeCache);

    const snapshotFile = join(stack.destinationDir, "check.sqlite");
    writeFileSync(snapshotFile, entries.find((entry) => entry.path === "database.sqlite")?.bytes ?? Buffer.alloc(0));
    const snapshot = new Database(snapshotFile, { readonly: true });
    try {
      const availability = (id: string): unknown => (snapshot.prepare("SELECT availability FROM media_asset WHERE id = ?").get(id) as { availability: string }).availability;
      expect(availability(library.original.assetId)).toBe(includeOriginals ? "available" : "missing");
      expect(availability(library.cache.assetId)).toBe(includeCache ? "available" : "evicted");
    } finally {
      snapshot.close();
    }
  });

  it("exports a library whose revisions were folded and deleted, and the snapshot passes the restore checks", async () => {
    const { h, library, stack, target, request } = await setup();
    const { contentId, fixture } = library;
    h.contents.setPrimary(LOCAL, contentId, fixture.corrected.revision.id);
    const edit = (baseRevisionId: string) => {
      const base = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, baseRevisionId));
      h.transcripts.putDraft(LOCAL, contentId, {
        baseRevisionId,
        segments: base.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: `${segment.text}!`, sourceSegmentIds: [segment.id] })),
      });
      const primary = h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId)?.primaryTranscriptRevisionId) as string;
      return h.transcripts.commitDraft(LOCAL, contentId, { expectedPrimaryRevisionId: primary });
    };
    const first = edit(fixture.corrected.revision.id);
    const second = edit(first.id);
    expect(second.parentRevisionId).toBe(fixture.corrected.revision.id);
    const third = edit(second.id);
    h.contents.setPrimary(LOCAL, contentId, fixture.corrected.revision.id);
    h.transcripts.deleteRevision(LOCAL, third.id, { withDescendants: false });
    expect(countRows(h.db, "transcript_revision", "content_id = ?", contentId)).toBe(3);

    const { jobId } = stack.service.start(request({ includeOriginals: false, includeCache: false }));
    expect((await settled(stack, jobId)).status).toBe("succeeded");
    const entries = await readArchive(target);
    const snapshotFile = join(stack.destinationDir, "check.sqlite");
    writeFileSync(snapshotFile, entries.find((entry) => entry.path === "database.sqlite")?.bytes ?? Buffer.alloc(0));
    const staged = StagedDatabase.open(snapshotFile);
    try {
      expect(() => staged.verify()).not.toThrow();
      expect(staged.unresolvedMarkers()).toBe(0);
    } finally {
      staged.close();
    }
  });

  it("estimates by registered sizes", async () => {
    const { library, stack } = await setup();
    const estimate = stack.service.estimate({ includeOriginals: true, includeCache: true });
    expect(estimate.database.bytes).toBeGreaterThan(0);
    expect(estimate.originals).toEqual({ count: 1, bytes: library.original.bytes.length, unreadable: [] });
    expect(estimate.cache).toEqual({ count: 1, bytes: library.cache.bytes.length });
    expect(stack.service.estimate({ includeOriginals: false, includeCache: false }).originals).toEqual({ count: 0, bytes: 0, unreadable: [] });
  });
});

