import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalImportService, type UploadPart } from "../../../src/server/application/local-import.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { FairSemaphore } from "../../../src/server/pipeline/fair-semaphore.ts";
import type { LocalMediaIngest } from "../../../src/server/ports/local-media-ingest.ts";
import { mediaFixtures } from "../../fixtures/media/index.ts";
import { BYTES_PER_GB } from "../../../src/shared/units.ts";
import { builtinPromptRefs, BOB, LOCAL, taskOf } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack, type MediaStackOptions } from "../../fixtures/pipeline/media-stack.ts";
import { countRows, tempDataDir } from "../../tools/sqlite.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

function stack(options: MediaStackOptions = {}): MediaStack {
  const created = createMediaStack(options);
  open.push(created);
  return created;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a rejection");
}

async function* bytes(data: Buffer, chunk = 64 * 1024): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += chunk) {
    yield data.subarray(offset, offset + chunk);
  }
}

async function* partsOf(...parts: UploadPart[]): AsyncIterable<UploadPart> {
  yield* parts;
}

/** No file under `assets/`, and no directory made for a refused upload either. */
async function expectNothingLeft(s: MediaStack): Promise<void> {
  expect(await s.files.list("assets")).toEqual([]);
  const root = join(s.h.dir, "assets");
  const contentDirs = existsSync(root) ? readdirSync(root).flatMap((user) => readdirSync(join(root, user))) : [];
  expect(contentDirs).toEqual([]);
}

const field = (name: string, value: string): UploadPart => ({ kind: "field", name, value });
const file = (name: string, data: Buffer, filename = "lecture.mp4"): UploadPart => ({ kind: "file", name, filename, stream: bytes(data) });
const fixtureBytes = (name: "withAudio" | "noAudio" | "audioOnly") => readFileSync(mediaFixtures()[name].path);
const SRT = Buffer.from("1\n00:00:00,500 --> 00:00:02,000\n第一句\n\n2\n00:00:02,000 --> 00:00:03,000\n第二句\n");

describe("upload", () => {
  it("streams the media part into a managed upload and creates everything in one go", async () => {
    const s = stack();
    const result = await s.localImport.upload(
      LOCAL,
      partsOf(field("settings", JSON.stringify({ autoProofread: false })), field("subtitleLanguage", "zh-cn"), file("subtitle", SRT, "a.srt"), file("file", fixtureBytes("withAudio"))),
    );
    expect(result.status).toBe(202);
    const contentId = result.body.contentIds[0] as string;
    const [asset] = s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId));
    expect(asset).toMatchObject({ kind: "managed_upload", displayName: "lecture.mp4", mimeType: "video/mp4", retentionPolicy: "keep", availability: "available" });
    expect(asset?.storageRef).toBe(`assets/${LOCAL.userId}/${contentId}/${asset?.id}`);
    expect(asset?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await s.files.digest(asset?.storageRef as string)).toBe(asset?.fingerprint);

    const content = s.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
    const revision = s.h.repository.withTransaction((scope) => scope.transcripts.getRevision(LOCAL.userId, content?.primaryTranscriptRevisionId as string));
    expect(revision).toMatchObject({ kind: "imported", language: "zh-CN", segmentCount: 2 });
    const task = taskOf(s.h, result.body.taskIds[0] as string);
    expect(JSON.parse(task.requestJson)).toEqual({
      requestSchemaVersion: 1,
      kind: "process_content",
      promptRefs: builtinPromptRefs("process_content"),
      autoProofread: false,
      templateRef: { id: "summary.core", version: 1 },
      initialSubtitleRevisionId: revision?.id,
    });
    expect(s.h.repository.withTransaction((scope) => scope.importBatches.get(LOCAL.userId, result.body.importBatchId))).toMatchObject({ sourceType: "upload", totalItems: 1 });
  });

  it("takes the retention policy from the effective instance setting at upload time", async () => {
    const s = stack({ overrides: { uploadRetentionDefault: "discard_after_audio" } });
    const result = await s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("audioOnly"), "talk.mp3")));
    const [asset] = s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, result.body.contentIds[0] as string));
    expect(asset).toMatchObject({ retentionPolicy: "discard_after_audio", mimeType: "audio/mpeg" });
  });

  it("cuts the media part at the streaming limit and leaves nothing behind", async () => {
    const s = stack({ maxUploadBytes: 1024 * 1024 });
    const error = await failure(s.localImport.upload(LOCAL, partsOf(file("file", Buffer.alloc(3 * 1024 * 1024, 7)))));
    expect(error).toMatchObject({ class: "media_too_large", code: "media_too_large", retryDisposition: "never" });
    expect(error.userMessage).toContain("1 MB");
    await expectNothingLeft(s);
    expect(countRows(s.h.db, "content")).toBe(0);
  });

  it("rejects a text file named like a video by sniffing its content", async () => {
    const s = stack();
    const error = await failure(s.localImport.upload(LOCAL, partsOf(file("file", Buffer.from("plain text, not a video\n".repeat(100)), "movie.mp4"))));
    expect(error).toMatchObject({ class: "media_unsupported_type", retryDisposition: "never" });
    await expectNothingLeft(s);
    expect(countRows(s.h.db, "content")).toBe(0);
  });

  it("refuses a duplicate unless allowDuplicate is set, removing the second copy", async () => {
    const s = stack();
    const first = await s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("withAudio"))));
    const error = await failure(s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("withAudio")))));
    expect(error).toMatchObject({ code: "conflict.duplicate_file", details: { duplicateOfContentId: first.body.contentIds[0], trashed: false } });
    expect(await s.files.list("assets")).toHaveLength(1);
    const again = await s.localImport.upload(LOCAL, partsOf(field("allowDuplicate", "true"), file("file", fixtureBytes("withAudio"))));
    expect(again.body.contentIds[0]).not.toBe(first.body.contentIds[0]);
    expect(await s.files.list("assets")).toHaveLength(2);
  });

  it("names a duplicate in the trash as such, preferring a copy outside it", async () => {
    const s = stack();
    const toTrash = (contentId: string) => s.h.repository.withTransaction((scope) => scope.contents.trash(LOCAL.userId, contentId, Date.now()));
    const first = await s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("withAudio"))));
    const firstId = first.body.contentIds[0] as string;
    toTrash(firstId);
    const inTrash = await failure(s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("withAudio")))));
    expect(inTrash).toMatchObject({ code: "conflict.duplicate_file", details: { duplicateOfContentId: firstId, trashed: true } });
    const second = await s.localImport.upload(LOCAL, partsOf(field("allowDuplicate", "true"), file("file", fixtureBytes("withAudio"))));
    expect(second.body.skippedTrashedContentIds).toEqual([]);
    const outside = await failure(s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("withAudio")))));
    expect(outside).toMatchObject({ details: { duplicateOfContentId: second.body.contentIds[0], trashed: false } });
  });

  it("replays an idempotent upload without keeping a second file, and rejects a different body under the same key", async () => {
    const s = stack();
    const first = await s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("withAudio"))), "key-1");
    const replay = await s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("withAudio"))), "key-1");
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await s.files.list("assets")).toHaveLength(1);
    const error = await failure(s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("audioOnly"))), "key-1"));
    expect(error.class).toBe("idempotency_conflict");
    expect(await s.files.list("assets")).toHaveLength(1);
  });

  it("enforces the part order and the rules of each part", async () => {
    const s = stack();
    const media = () => file("file", fixtureBytes("withAudio"));
    const cases: Array<[string, UploadPart[], string]> = [
      ["missing file", [field("settings", "{}")], "invalid_request"],
      ["out of order", [media(), field("settings", "{}")], "invalid_request"],
      ["duplicate part", [field("allowDuplicate", "true"), field("allowDuplicate", "true"), media()], "invalid_request"],
      ["unknown part", [field("extra", "x"), media()], "invalid_request"],
      ["bad settings", [field("settings", "{nope"), media()], "invalid_request"],
      ["bad flag", [field("allowDuplicate", "yes"), media()], "invalid_request"],
      ["subtitle without language", [file("subtitle", SRT), media()], "invalid_request"],
      ["subtitle not UTF-8", [field("subtitleLanguage", "zh"), file("subtitle", Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), media()], "invalid_request.subtitle_encoding"],
      ["subtitle unknown format", [field("subtitleLanguage", "zh"), file("subtitle", Buffer.from("notes")), media()], "invalid_request.subtitle_format"],
      ["file as a field", [field("file", "x")], "invalid_request"],
    ];
    for (const [label, parts, code] of cases) {
      expect((await failure(s.localImport.upload(LOCAL, partsOf(...parts)))).code, label).toBe(code);
    }
    await expectNothingLeft(s);
    expect(countRows(s.h.db, "content")).toBe(0);
  });

  it("refuses to start receiving below the disk watermark", async () => {
    const s = stack();
    s.h.disk.low();
    expect((await failure(s.localImport.upload(LOCAL, partsOf(file("file", fixtureBytes("withAudio")))))).class).toBe("disk_low");
    await expectNothingLeft(s);
  });
});

describe("heavy-job governor", () => {
  it("probes the upload holding a heavy-job slot in the uploader's foreground group", async () => {
    const s = stack();
    const governor = new FairSemaphore(() => 1);
    const groups: string[] = [];
    let probing = 0;
    let heldWhileProbing = 0;
    const ingest: Pick<LocalMediaIngest, "probe"> = {
      probe: (path, signal) => {
        probing += 1;
        heldWhileProbing = governor.inFlight;
        return s.ingest.probe(path, signal);
      },
    };
    const localImport = new LocalImportService({
      repository: s.h.repository,
      bus: s.h.bus,
      control: { kick: () => undefined },
      files: s.files,
      ingest: ingest as LocalMediaIngest,
      disk: s.h.disk,
      settings: s.h.settings,
      newId: s.h.newId,
      heavy: {
        run: (ref, signal, work) => {
          groups.push(ref.key);
          return governor.run(ref, signal, work);
        },
      },
    });
    const release = await governor.acquire({ key: "task:other", createdAt: 0 }, new AbortController().signal);
    const upload = localImport.upload(BOB, partsOf(file("file", fixtureBytes("withAudio"))));
    await vi.waitFor(() => expect(groups).toEqual([`foreground:${BOB.userId}`]));
    // The only slot is taken: the probe waits for it.
    expect(probing).toBe(0);
    release();
    expect((await upload).status).toBe(202);
    expect(probing).toBe(1);
    expect(heldWhileProbing).toBe(1);
    expect(governor.inFlight).toBe(0);
  });
});

describe("storage quota", () => {
  const limitOf = (s: MediaStack, bytes: number) =>
    s.h.db.prepare("UPDATE user SET storage_limit_gb = ? WHERE id = ?").run(bytes / BYTES_PER_GB, BOB.userId);

  it("aborts an upload as soon as its bytes cross the owner's limit and leaves nothing behind", async () => {
    const s = stack();
    const data = fixtureBytes("withAudio");
    limitOf(s, data.length - 1);
    const error = await failure(s.localImport.upload(BOB, partsOf(file("file", data))));
    expect(error).toMatchObject({ class: "storage_quota_exceeded", code: "storage_quota_exceeded" });
    await expectNothingLeft(s);
    expect(countRows(s.h.db, "content")).toBe(0);

    // Exactly at the limit fits; the next upload finds the quota used up before reading anything.
    limitOf(s, data.length);
    expect((await s.localImport.upload(BOB, partsOf(file("file", data)))).status).toBe(202);
    let read = false;
    async function* untouched(): AsyncIterable<Uint8Array> {
      read = true;
      yield Buffer.from("x");
    }
    limitOf(s, data.length - 1);
    const refused = await failure(s.localImport.upload(BOB, partsOf({ kind: "file", name: "file", filename: "b.mp4", stream: untouched() })));
    expect(refused.class).toBe("storage_quota_exceeded");
    expect(read).toBe(false);
  });

  it("counts bytes of uploads still streaming and leaves users without a limit alone", async () => {
    const s = stack();
    const data = fixtureBytes("withAudio");
    limitOf(s, data.length + 10);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    async function* slow(): AsyncIterable<Uint8Array> {
      yield data.subarray(0, 20);
      await held;
      yield data.subarray(20);
    }
    const first = s.localImport.upload(BOB, partsOf({ kind: "file", name: "file", filename: "a.mp4", stream: slow() }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 20 bytes in flight + the whole second file cross the limit.
    expect((await failure(s.localImport.upload(BOB, partsOf(file("file", data))))).class).toBe("storage_quota_exceeded");
    release();
    expect((await first).status).toBe(202);
    expect((await s.localImport.upload(LOCAL, partsOf(file("file", data)))).status).toBe(202);
  });
});

describe("local file", () => {
  it("references the granted file in place with its fingerprint and an optional subtitle", async () => {
    const s = stack();
    const { withAudio } = mediaFixtures();
    const subtitlePath = join(tempDataDir("amber-sub-"), "lecture.srt");
    writeFileSync(subtitlePath, SRT);
    const result = await s.localImport.importLocalFile(LOCAL, {
      path: withAudio.path,
      grant: s.grant(withAudio.path),
      settings: { autoProofread: true },
      allowDuplicate: false,
      initialSubtitle: { path: subtitlePath, grant: s.grant(subtitlePath), language: "en-us" },
    });
    const contentId = result.body.contentIds[0] as string;
    const [asset] = s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId));
    expect(asset).toMatchObject({ kind: "external_local", storageRef: withAudio.path, displayName: "with-audio.mp4", retentionPolicy: "never_delete" });
    expect(asset?.fingerprint).toMatch(/^sha256:/);
    const content = s.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
    expect(s.h.repository.withTransaction((scope) => scope.transcripts.getRevision(LOCAL.userId, content?.primaryTranscriptRevisionId as string))?.language).toBe("en-US");
    expect(s.h.repository.withTransaction((scope) => scope.importBatches.get(LOCAL.userId, result.body.importBatchId))?.sourceType).toBe("local_file");
    await expectNothingLeft(s);

    const duplicate = await failure(s.localImport.importLocalFile(LOCAL, { path: withAudio.path, grant: s.grant(withAudio.path), settings: { autoProofread: true }, allowDuplicate: false }));
    expect(duplicate).toMatchObject({ code: "conflict.duplicate_file", details: { duplicateOfContentId: contentId } });
  });

  it("requires a grant for exactly this file and a readable regular file", async () => {
    const s = stack();
    const { withAudio } = mediaFixtures();
    const other = mediaFixtures().noAudio.path;
    const base = { settings: { autoProofread: true }, allowDuplicate: true } as const;
    expect((await failure(s.localImport.importLocalFile(LOCAL, { ...base, path: withAudio.path, grant: s.grant(other) }))).code).toBe("unauthenticated.file_grant");
    expect((await failure(s.localImport.importLocalFile(LOCAL, { ...base, path: withAudio.path, grant: s.grant(withAudio.path, "relink") }))).code).toBe("unauthenticated.file_grant");
    const dir = tempDataDir("amber-dir-");
    expect((await failure(s.localImport.importLocalFile(LOCAL, { ...base, path: dir, grant: s.grant(dir) }))).class).toBe("invalid_request");
    const missing = join(dir, "gone.mp4");
    expect((await failure(s.localImport.importLocalFile(LOCAL, { ...base, path: missing, grant: s.grant(missing) }))).class).toBe("invalid_request");
    expect((await failure(s.localImport.importLocalFile(LOCAL, { ...base, path: "relative.mp4", grant: s.grant("relative.mp4") }))).class).toBe("invalid_request");
    const subtitle = { path: withAudio.path, grant: s.grant(other), language: "zh" };
    expect((await failure(s.localImport.importLocalFile(LOCAL, { ...base, path: withAudio.path, grant: s.grant(withAudio.path), initialSubtitle: subtitle }))).code).toBe(
      "unauthenticated.file_grant",
    );
    expect(countRows(s.h.db, "content")).toBe(0);
  });
});
