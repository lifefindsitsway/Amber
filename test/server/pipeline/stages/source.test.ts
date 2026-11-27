import { readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BilibiliAdapter } from "../../../../src/server/adapters/platform/bilibili/index.ts";
import { COOKIES_DIR, YtDlp } from "../../../../src/server/adapters/platform/yt-dlp.ts";
import { insertRow } from "../../../tools/sqlite.ts";
import { ContentCoverService } from "../../../../src/server/application/content-covers.ts";
import { DescriptionClock } from "../../../../src/server/domain/content-description.ts";
import { amberError, isAmberError } from "../../../../src/server/domain/errors.ts";
import type { StageExecutionContext } from "../../../../src/server/pipeline/executor.ts";
import type { PlatformAccess } from "../../../../src/server/pipeline/stages/platform-access.ts";
import { SourceStageExecutor } from "../../../../src/server/pipeline/stages/source.ts";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../../../src/server/ports/outbound-http.ts";
import type { PlatformDescription, PlatformMetadata, PlatformSourceAdapter } from "../../../../src/server/ports/platform-source.ts";
import type { ProcessResult, ProcessRunner, ProcessRunOptions, ProcessSpec } from "../../../../src/server/ports/process-runner.ts";
import { createHarness, LOCAL, type Harness } from "../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

const BVID = "BV1src41c001";
const DURATION_MS = 600_000;

function platformContent(h: Harness, extra: { rawLanguage?: string; platformPartId?: string } = {}): string {
  const contentId = h.newId();
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id: contentId,
      userId: LOCAL.userId,
      source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${BVID}`, platformContentId: BVID, platformPartId: extra.platformPartId ?? `${BVID}-cid` },
      ...(extra.rawLanguage === undefined ? {} : { rawLanguage: extra.rawLanguage }),
      processingStatus: "running",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return contentId;
}

/** Platform calls of the scripted bilibili adapter made while a heavy slot was held. */
async function runSource(
  h: Harness,
  contentId: string,
  platforms: PlatformAccess = h.platformAccess,
  slotted: string[] = [],
  options: { descriptionClock?: DescriptionClock; now?: () => number } = {},
): Promise<void> {
  const executor = new SourceStageExecutor({
    repository: h.repository,
    platforms,
    newId: h.newId,
    descriptionClock: options.descriptionClock ?? new DescriptionClock(Date.now),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const adapter = h.platforms.bilibili;
  const withHeavySlot = async <T>(work: () => Promise<T>): Promise<T> => {
    const before = adapter.calls.length;
    try {
      return await work();
    } finally {
      slotted.push(...adapter.calls.slice(before).map((call) => call.method));
    }
  };
  const context = { task: { userId: LOCAL.userId, contentId }, signal: new AbortController().signal, withHeavySlot } as unknown as StageExecutionContext;
  const outcome = await executor.run(context);
  h.repository.withTransaction((scope) => outcome.publish?.(scope));
}

function scriptMetadata(h: Harness, metadata: Partial<PlatformMetadata>): void {
  h.platforms.bilibili.video(BVID, { metadata });
}

const contentOf = (h: Harness, contentId: string) => h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
const currentChapters = (h: Harness, contentId: string) => h.repository.withTransaction((scope) => scope.chapters.getCurrent(LOCAL.userId, contentId));

describe("source stage", () => {
  it("publishes the platform metadata onto the Content", async () => {
    const h = harness();
    scriptMetadata(h, {
      title: "Lecture",
      durationMs: DURATION_MS,
      coverUrl: "https://i0.hdslb.com/cover.jpg",
      publishedAt: 1_790_000_000_000,
      channelId: "202224425",
      channelTitle: "Channel",
      rawLanguage: "zh-CN",
    });
    const contentId = platformContent(h);
    await runSource(h, contentId);
    expect(contentOf(h, contentId)).toMatchObject({
      title: "Lecture",
      durationMs: DURATION_MS,
      coverUrl: "https://i0.hdslb.com/cover.jpg",
      publishedAt: 1_790_000_000_000,
      rawLanguage: "zh-CN",
      source: { channelId: "202224425", channelTitle: "Channel" },
    });
  });

  it("fetches the metadata inside a heavy slot", async () => {
    const h = harness();
    scriptMetadata(h, { durationMs: DURATION_MS });
    const slotted: string[] = [];
    await runSource(h, platformContent(h), h.platformAccess, slotted);
    expect(slotted).toEqual(["fetchMetadata"]);
    expect(h.platforms.bilibili.callsOf("fetchMetadata")).toHaveLength(1);
  });

  it("keeps a raw language that is already known", async () => {
    const h = harness();
    scriptMetadata(h, { rawLanguage: "zh-CN" });
    const contentId = platformContent(h, { rawLanguage: "en" });
    await runSource(h, contentId);
    expect(contentOf(h, contentId)?.rawLanguage).toBe("en");
  });

  it("fails with source_unreachable when the platform reports no duration", async () => {
    const h = harness();
    scriptMetadata(h, { durationMs: 0 });
    const contentId = platformContent(h);
    const error = await runSource(h, contentId).catch((caught: unknown) => caught);
    expect(isAmberError(error) && error.appError.class).toBe("source_unreachable");
    expect(contentOf(h, contentId)?.durationMs).toBeUndefined();
  });

  it("stores creator chapters from 0 with derived ends and makes them current", async () => {
    const h = harness();
    scriptMetadata(h, {
      durationMs: DURATION_MS,
      chapters: [
        { startMs: 200_000, title: "Second" },
        { startMs: 3_000, title: " First " },
      ],
    });
    const contentId = platformContent(h);
    await runSource(h, contentId);
    const current = currentChapters(h, contentId);
    expect(current?.origin).toEqual({ kind: "platform" });
    expect(current?.chapters).toEqual([
      { startMs: 0, endMs: 200_000, title: "First" },
      { startMs: 200_000, endMs: DURATION_MS, title: "Second" },
    ]);
    expect(current?.provenance.inputs).toEqual([]);

    // The same chapters again: the same revision.
    await runSource(h, contentId);
    expect(currentChapters(h, contentId)?.id).toBe(current?.id);
  });

  it("stores nothing when the platform has no chapters", async () => {
    const h = harness();
    scriptMetadata(h, { durationMs: DURATION_MS, chapters: [] });
    const contentId = platformContent(h);
    await runSource(h, contentId);
    expect(currentChapters(h, contentId)).toBeUndefined();
    expect(h.repository.withTransaction((scope) => scope.chapters.hasPlatformChapters(LOCAL.userId, contentId))).toBe(false);
  });

  it("moves current to changed platform chapters but never away from AI chapters", async () => {
    const h = harness();
    scriptMetadata(h, { durationMs: DURATION_MS, chapters: [{ startMs: 0, title: "One" }] });
    const contentId = platformContent(h);
    await runSource(h, contentId);
    const first = currentChapters(h, contentId);

    scriptMetadata(h, { durationMs: DURATION_MS, chapters: [{ startMs: 0, title: "One" }, { startMs: 300_000, title: "Two" }] });
    await runSource(h, contentId);
    const second = currentChapters(h, contentId);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.chapters).toHaveLength(2);

    insertRow(h.db, "chapter_revision", {
      id: "ai-revision",
      artifact_id: second?.artifactId as string,
      inputs_json: "[]",
      quality: "normal",
      origin_json: JSON.stringify({ kind: "ai", transcriptRevisionId: "t" }),
      chapters_json: "[]",
      created_at: 2,
    });
    h.repository.withTransaction((scope) => scope.chapters.setCurrent(LOCAL.userId, contentId, "ai-revision"));
    scriptMetadata(h, { durationMs: DURATION_MS, chapters: [{ startMs: 0, title: "Three" }] });
    await runSource(h, contentId);
    expect(currentChapters(h, contentId)?.id).toBe("ai-revision");
  });
});

describe("source stage: the description", () => {
  const T = 1_790_000_000_000;
  const scriptDescription = (h: Harness, description: PlatformDescription) => scriptMetadata(h, { durationMs: DURATION_MS, description });
  const stored = (h: Harness, contentId: string) => {
    const content = contentOf(h, contentId);
    return { description: content?.description, truncated: content?.descriptionTruncated, checkedAt: content?.descriptionCheckedAt };
  };

  it("stores found text with the time the request was sent, capped, and leaves updatedAt to the metadata", async () => {
    const h = harness();
    scriptDescription(h, { state: "found", text: "简介\n第二行" });
    const contentId = platformContent(h);
    await runSource(h, contentId, h.platformAccess, [], { descriptionClock: new DescriptionClock(() => T), now: () => T + 500 });
    expect(stored(h, contentId)).toEqual({ description: "简介\n第二行", truncated: undefined, checkedAt: T });
    // The metadata write's time; the description write does not touch it.
    expect(contentOf(h, contentId)?.updatedAt).toBe(T + 500);

    scriptDescription(h, { state: "found", text: "a".repeat(10_001) });
    await runSource(h, contentId, h.platformAccess, [], { descriptionClock: new DescriptionClock(() => T + 1) });
    expect(stored(h, contentId)).toEqual({ description: "a".repeat(10_000), truncated: true, checkedAt: T + 1 });
  });

  it("clears the text when the platform says there is none and keeps it when the answer is unreadable", async () => {
    const h = harness();
    const contentId = platformContent(h);
    scriptDescription(h, { state: "found", text: "old" });
    await runSource(h, contentId, h.platformAccess, [], { descriptionClock: new DescriptionClock(() => T) });

    scriptDescription(h, { state: "unknown" });
    await runSource(h, contentId, h.platformAccess, [], { descriptionClock: new DescriptionClock(() => T + 10) });
    expect(stored(h, contentId)).toEqual({ description: "old", truncated: undefined, checkedAt: T });

    scriptDescription(h, { state: "empty" });
    await runSource(h, contentId, h.platformAccess, [], { descriptionClock: new DescriptionClock(() => T + 20) });
    expect(stored(h, contentId)).toEqual({ description: undefined, truncated: undefined, checkedAt: T + 20 });
  });

  it("writes nothing when the metadata read fails", async () => {
    const h = harness();
    const contentId = platformContent(h);
    scriptDescription(h, { state: "found", text: "kept" });
    await runSource(h, contentId, h.platformAccess, [], { descriptionClock: new DescriptionClock(() => T) });
    h.platforms.bilibili.video(BVID, { metadata: { durationMs: DURATION_MS, description: { state: "empty" } }, metadataError: amberError("platform_blocked", "blocked") });
    const error = await runSource(h, contentId, h.platformAccess, [], { descriptionClock: new DescriptionClock(() => T + 10) }).catch((caught: unknown) => caught);
    expect(isAmberError(error) && error.appError.class).toBe("platform_blocked");
    expect(stored(h, contentId)).toEqual({ description: "kept", truncated: undefined, checkedAt: T });
  });

  it("takes the time before the request: a later write landing while the request is out is not overwritten", async () => {
    const h = harness();
    const contentId = platformContent(h);
    const clock = new DescriptionClock(() => T);
    const adapter = h.platforms.bilibili;
    const fetchMetadata = adapter.fetchMetadata.bind(adapter);
    adapter.fetchMetadata = async (ref, auth) => {
      // A manual fetch sent after the stage's request, answered first.
      const manual = h.repository.withTransaction((scope) =>
        scope.contents.setDescription(LOCAL.userId, contentId, { description: "manual", truncated: false, checkedAt: clock.issue() }, T),
      );
      expect(manual).toBe(true);
      return { ...(await fetchMetadata(ref, auth)), durationMs: DURATION_MS, description: { state: "found", text: "stage" } };
    };
    await runSource(h, contentId, h.platformAccess, [], { descriptionClock: clock });
    expect(stored(h, contentId)).toEqual({ description: "manual", truncated: undefined, checkedAt: T + 1 });
    // The rest of the metadata is published as usual.
    expect(contentOf(h, contentId)?.durationMs).toBe(DURATION_MS);
  });
});

/** Answers the bilibili web API by path; records every request's Cookie header presence. */
class ScriptedHttp implements OutboundHttpClient {
  readonly requests: Array<{ url: string; cookie: string | undefined }> = [];

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push({ url: request.url, cookie: request.headers?.["Cookie"] });
    const path = new URL(request.url).pathname;
    const data =
      path === "/x/player/pagelist"
        ? [{ cid: 111, page: 1, part: "Part", duration: 600 }]
        : path === "/x/player/wbi/v2"
          ? { subtitle: { subtitles: [] } }
          : undefined;
    const text = JSON.stringify({ code: data === undefined ? -404 : 0, data });
    return {
      status: 200,
      headers: new Map(),
      body: (async function* () {
        yield Buffer.from(text);
      })(),
      text: async () => text,
    };
  }
}

/** Stands in for yt-dlp: inspects the cookie file it was handed while "running". */
class ScriptedYtDlp implements ProcessRunner {
  readonly seen: Array<{ cookieFile: string | undefined; mode: number | undefined; carriesCookie: boolean }> = [];
  result: ProcessResult = {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({ title: "Lecture", duration: 600, uploader: "Channel", uploader_id: 202224425, chapters: [{ start_time: 0, end_time: 600, title: "All" }] }),
    stderr: "",
  };

  async run(spec: ProcessSpec, opts: ProcessRunOptions): Promise<ProcessResult> {
    const at = spec.args.indexOf("--cookies");
    const cookieFile = at === -1 ? undefined : spec.args[at + 1];
    this.seen.push({
      cookieFile,
      mode: cookieFile === undefined ? undefined : statSync(cookieFile).mode & 0o777,
      carriesCookie: cookieFile !== undefined && readFileSync(cookieFile, "utf8").includes("<placeholder>"),
    });
    // Like the real runner, stdout also arrives line by line.
    for (const line of this.result.stdout.split("\n").filter((line) => line !== "")) {
      opts.onStdoutLine?.(line);
    }
    return this.result;
  }
}

function realBilibili(h: Harness) {
  const runner = new ScriptedYtDlp();
  const http = new ScriptedHttp();
  const adapter = new BilibiliAdapter({ ytDlp: new YtDlp({ runner, binDir: "/opt/amber-bin", dataDir: h.dir, env: {} }), http });
  const platforms: PlatformAccess = { ...h.platformAccess, adapterFor: () => adapter };
  return { runner, http, platforms };
}

/** Every stored secret column, blobs read as text, to search for plaintext. */
function secretTableText(h: Harness): string {
  const rows = h.db.prepare("SELECT * FROM secret").all() as Array<Record<string, unknown>>;
  return rows.map((row) => Object.values(row).map((value) => (Buffer.isBuffer(value) ? value.toString("latin1") : String(value))).join("|")).join("\n");
}

describe("a platform login is materialized only for the call that needs it", () => {
  it("hands yt-dlp a private cookie file, removes it afterwards and keeps only ciphertext at rest", async () => {
    const h = harness();
    h.platformAccounts.putCookies(LOCAL, "bilibili", "bili_session=<placeholder>");
    const { runner, http, platforms } = realBilibili(h);
    const contentId = platformContent(h, { platformPartId: "111" });
    await runSource(h, contentId, platforms);

    expect(contentOf(h, contentId)).toMatchObject({ title: "Lecture", durationMs: DURATION_MS, source: { channelId: "202224425" } });
    expect(runner.seen).toEqual([{ cookieFile: expect.stringContaining(join(h.dir, COOKIES_DIR)), mode: 0o600, carriesCookie: true }]);
    expect(statSync(join(h.dir, COOKIES_DIR)).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(h.dir, COOKIES_DIR))).toEqual([]);
    // The web API calls carried the login as a header, never through a file.
    expect(http.requests.every((request) => request.cookie?.includes("<placeholder>") === true)).toBe(true);

    const stored = secretTableText(h);
    expect(stored).not.toBe("");
    expect(stored).not.toContain("<placeholder>");
    expect(stored).not.toContain("bili_session");
  });

  it("removes the cookie file when yt-dlp fails too", async () => {
    const h = harness();
    h.platformAccounts.putCookies(LOCAL, "bilibili", "bili_session=<placeholder>");
    const { runner, platforms } = realBilibili(h);
    runner.result = { exitCode: 1, signal: null, stdout: "", stderr: "ERROR: [BiliBili] BV1src41c001: Unable to download JSON metadata: HTTP Error 412" };
    const contentId = platformContent(h, { platformPartId: "111" });
    const error = await runSource(h, contentId, platforms).catch((caught: unknown) => caught);
    expect(isAmberError(error) && error.appError.class).toBe("platform_blocked");
    expect(runner.seen[0]?.carriesCookie).toBe(true);
    expect(readdirSync(join(h.dir, COOKIES_DIR))).toEqual([]);
  });

  it("writes no cookie file without a login", async () => {
    const h = harness();
    const { runner, platforms } = realBilibili(h);
    await runSource(h, platformContent(h, { platformPartId: "111" }), platforms);
    expect(runner.seen).toEqual([{ cookieFile: undefined, mode: undefined, carriesCookie: false }]);
  });
});

describe("source stage: the local cover copy", () => {
  const COVER = "https://i0.hdslb.com/bfs/archive/cover.jpg";
  const image = { bytes: new Uint8Array([1, 2, 3]), width: 16, height: 9, sha256: "ab".repeat(32) };

  /** The cover service over a stand-in image processor, and the bilibili adapter's scripted `fetchCover`. */
  function coverSetup(h: Harness, answer: () => Promise<void>, timeoutMs?: number) {
    const fetched: string[] = [];
    const fetchCover: NonNullable<PlatformSourceAdapter["fetchCover"]> = async (url, output) => {
      fetched.push(url);
      h.platforms.bilibili.calls.push({ method: "fetchCover", target: url, withAuth: false });
      await answer();
      await writeFile(output.path, "image");
      return { sizeBytes: 5 };
    };
    Object.assign(h.platforms.bilibili, { fetchCover });
    const images = {
      normalizeFetched: async (_owner: string, fill: (input: { path: string }) => Promise<unknown>) => {
        await fill({ path: join(h.dir, `cover-${h.newId()}`) });
        return image;
      },
    };
    const covers = new ContentCoverService({ repository: h.repository, platforms: h.platformAccess, images, details: h.contents, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return { fetched, covers };
  }

  async function runWithCovers(h: Harness, contentId: string, covers: ContentCoverService, slotted: string[] = []): Promise<void> {
    const executor = new SourceStageExecutor({ repository: h.repository, platforms: h.platformAccess, newId: h.newId, descriptionClock: new DescriptionClock(Date.now), covers });
    const adapter = h.platforms.bilibili;
    const withHeavySlot = async <T>(work: () => Promise<T>): Promise<T> => {
      const before = adapter.calls.length;
      try {
        return await work();
      } finally {
        slotted.push(...adapter.calls.slice(before).map((call) => call.method));
      }
    };
    const context = { task: { userId: LOCAL.userId, contentId }, signal: new AbortController().signal, withHeavySlot } as unknown as StageExecutionContext;
    const outcome = await executor.run(context);
    h.repository.withTransaction((scope) => outcome.publish?.(scope));
  }

  it("downloads the cover once, outside the heavy slot, as version 1; a re-run keeps it", async () => {
    const h = harness();
    scriptMetadata(h, { durationMs: DURATION_MS, coverUrl: COVER });
    const { fetched, covers } = coverSetup(h, async () => undefined);
    const contentId = platformContent(h);
    const slotted: string[] = [];
    await runWithCovers(h, contentId, covers, slotted);
    expect(slotted).toEqual(["fetchMetadata"]);
    expect(fetched).toEqual([COVER]);
    expect(contentOf(h, contentId)).toMatchObject({ coverUrl: COVER, coverImageVersion: 1 });

    await runWithCovers(h, contentId, covers);
    expect(fetched).toHaveLength(1);
    expect(contentOf(h, contentId)?.coverImageVersion).toBe(1);
  });

  it("succeeds without a cover when the download fails or runs past the time limit", async () => {
    for (const [name, answer] of [
      ["refused", () => Promise.reject(amberError("platform_blocked", "refused"))],
      ["never answers", () => new Promise<void>(() => undefined)],
    ] as const) {
      const h = harness();
      scriptMetadata(h, { title: "Lecture", durationMs: DURATION_MS, coverUrl: COVER });
      const { covers } = coverSetup(h, answer, 30);
      const contentId = platformContent(h);
      await runWithCovers(h, contentId, covers);
      expect([name, contentOf(h, contentId)]).toMatchObject([name, { title: "Lecture", coverUrl: COVER }]);
      expect([name, contentOf(h, contentId)?.coverImageVersion]).toEqual([name, undefined]);
    }
  });

  it("asks for nothing when the platform gives no cover", async () => {
    const h = harness();
    scriptMetadata(h, { durationMs: DURATION_MS });
    const { fetched, covers } = coverSetup(h, async () => undefined);
    await runWithCovers(h, platformContent(h), covers);
    expect(fetched).toEqual([]);
  });
});

describe("source stage after an import check", () => {
  const NOTE = "64e0a1b2c3d4e5f600112233";
  const URL_WITH_TOKEN = `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=xxxxtok1&xsec_source=pc_feed`;

  async function imported(h: Harness, acceptUnverified = false): Promise<string> {
    const { body } = await h.importContent.import(LOCAL, { items: [{ url: URL_WITH_TOKEN, ...(acceptUnverified ? { acceptUnverified } : {}) }], settings: { autoProofread: true } });
    return body.contentIds[0] as string;
  }

  it("publishes the metadata the check read, asking the platform once from paste to source", async () => {
    const h = harness();
    h.platforms.xiaohongshu.video(NOTE, {
      metadata: {
        title: "番茄牛腩面",
        durationMs: 284_867,
        coverUrl: "https://sns-webpic-qc.xhscdn.com/x/xxxxcover",
        publishedAt: 1_794_830_642_000,
        channelTitle: "厨房里的小王",
        description: { state: "found", text: "简介 #家常菜" },
      },
    });
    await h.importContent.inspect(LOCAL, { url: URL_WITH_TOKEN });
    const contentId = await imported(h);
    await runSource(h, contentId);
    expect(h.platforms.xiaohongshu.callsOf("precheck")).toHaveLength(1);
    expect(h.platforms.xiaohongshu.callsOf("fetchMetadata")).toHaveLength(0);
    expect(contentOf(h, contentId)).toMatchObject({
      title: "番茄牛腩面",
      durationMs: 284_867,
      coverUrl: "https://sns-webpic-qc.xhscdn.com/x/xxxxcover",
      publishedAt: 1_794_830_642_000,
      source: { channelTitle: "厨房里的小王" },
      description: "简介 #家常菜",
    });
  });

  it("asks the platform when no check read the link, as for a link imported unverified", async () => {
    const h = harness();
    h.platforms.xiaohongshu.checks.set(NOTE, { result: "unverified" });
    const contentId = await imported(h, true);
    await runSource(h, contentId);
    expect(h.platforms.xiaohongshu.callsOf("fetchMetadata")).toHaveLength(1);
    expect(contentOf(h, contentId)?.title).toBe(`title ${NOTE}`);
  });
});
