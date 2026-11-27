import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DirectOutboundHttpClient } from "../../src/server/adapters/outbound-http/direct.ts";
import { BilibiliAdapter } from "../../src/server/adapters/platform/bilibili/index.ts";
import { DouyinAdapter } from "../../src/server/adapters/platform/douyin/index.ts";
import { YoutubeAdapter } from "../../src/server/adapters/platform/youtube/index.ts";
import { YtDlp, type YtDlpRun } from "../../src/server/adapters/platform/yt-dlp.ts";
import { NodeProcessRunner } from "../../src/server/adapters/process-runner/node-process-runner.ts";
import { canonicalPlatformCookies } from "../../src/server/domain/platform-cookie.ts";
import { selectSubtitleTrack } from "../../src/server/domain/platform-subtitle.ts";
import type { PlatformCredential, PlatformMetadata } from "../../src/server/ports/platform-source.ts";
import { childProcessEnv } from "../../src/server/ports/process-runner.ts";
import { COLLECTION_PREVIEW_ITEMS_MAX } from "../../src/shared/defaults.ts";
import { toolsBinDir } from "../fixtures/tools.ts";

/**
 * Real platform smoke test. Runs only with `AMBER_E2E_PLATFORM=1` and a per-run approval
 * (no paid call without the env switch and per-run approval). Inputs come from the
 * environment and never enter git:
 *
 * - `AMBER_E2E_BILIBILI_COOKIES_FILE`: a cookies.txt or Cookie header outside the repo;
 * - `AMBER_E2E_BILIBILI_URL` (optional): lecture 3 of the first use-case course's
 *   collection; looked up in the collection by title when unset;
 * - `AMBER_E2E_YOUTUBE_CC_URL`: a public CC-licensed video;
 * - `AMBER_E2E_DOUYIN_URL`: a public Douyin video, read as a visitor (no login exists);
 * - `AMBER_E2E_RECORD_DIR` (optional): where to write redacted fixtures.
 *
 * Nothing here prints cookies, signed subtitle URLs or response bodies.
 */

const enabled = process.env["AMBER_E2E_PLATFORM"] === "1";
const A11_COLLECTION = "202224425_8942017";
const LECTURE_3_TITLE = /软件仓库管理(?!\s*[(（]\s*2)/;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** Keeps the last `-J` document in memory so a redacted copy can be recorded without another request. */
class CapturingYtDlp extends YtDlp {
  lastJson: unknown;

  override async json<T>(run: YtDlpRun): Promise<T> {
    const value = await super.json<T>(run);
    this.lastJson = value;
    return value;
  }
}

function ytDlp(): CapturingYtDlp {
  return new CapturingYtDlp({
    runner: new NodeProcessRunner(),
    binDir: toolsBinDir(["yt-dlp", "deno", "ffmpeg"]),
    dataDir: mkdtempSync(join(tmpdir(), "amber-e2e-platform-")),
    env: childProcessEnv(process.env),
  });
}

/** Metadata without the adapter-private locators, fit for a fixture. */
function redacted(metadata: PlatformMetadata) {
  return { ...metadata, subtitleTracks: metadata.subtitleTracks.map(({ locator: _locator, ...track }) => track) };
}

/**
 * An info document fit for a fixture: no cookies or request headers anywhere, and URLs
 * cut at the query string, where signatures, expiry and the client address live.
 */
function redactedInfo(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactedInfo);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cookies" && key !== "http_headers" && key !== "fragments")
        .map(([key, inner]) => [key, redactedInfo(inner)]),
    );
  }
  if (typeof value === "string" && /^https?:\/\//.test(value) && value.includes("?")) {
    return `${value.slice(0, value.indexOf("?"))}?<redacted>`;
  }
  return value;
}

function record(name: string, value: unknown): void {
  const dir = process.env["AMBER_E2E_RECORD_DIR"];
  if (dir !== undefined && dir !== "") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }
}

const signal = (): AbortSignal => AbortSignal.timeout(120_000);

describe.skipIf(!enabled)("real platforms", () => {
  it("bilibili with a login: metadata, subtitle list and one subtitle of lecture 3", async () => {
    const adapter = new BilibiliAdapter({ ytDlp: ytDlp(), http: new DirectOutboundHttpClient() });
    const cookies = canonicalPlatformCookies(readFileSync(required("AMBER_E2E_BILIBILI_COOKIES_FILE"), "utf8"), adapter.cookieDomains, Date.now());
    const auth: PlatformCredential = { platform: "bilibili", cookies: async () => cookies };
    expect(await adapter.checkCredential(auth, signal())).toBe("valid");

    let url = process.env["AMBER_E2E_BILIBILI_URL"];
    if (url === undefined || url === "") {
      const listing = await adapter.listCollection(A11_COLLECTION, auth, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
      const items = await adapter.resolveCollectionEntries(A11_COLLECTION, listing.entries, auth, signal());
      url = items.find((item) => [item.title, item.displayTitle].some((title) => LECTURE_3_TITLE.test(title ?? "")))?.canonicalUrl;
    }
    const parsed = adapter.parse(url ?? "");
    expect(parsed?.platformContentId).toBeDefined();
    const [part] = await adapter.resolveParts({ platformContentId: parsed?.platformContentId as string }, auth, signal());
    const ref = { platformContentId: parsed?.platformContentId as string, platformPartId: part?.platformPartId as string };

    const metadata = await adapter.fetchMetadata(ref, auth, signal());
    expect(metadata.durationMs).toBeGreaterThan(90 * 60_000);
    // pagelist reports whole seconds; yt-dlp may carry a fraction.
    expect(Math.abs((part?.durationMs ?? 0) - metadata.durationMs)).toBeLessThanOrEqual(1000);
    expect(metadata.chapters?.length ?? 0).toBeGreaterThan(0);
    const original = metadata.subtitleTracks.find((track) => !track.translated && track.language.startsWith("zh"));
    expect(original).toBeDefined();
    expect(metadata.subtitleTracks.filter((track) => track.translated).length).toBeGreaterThan(0);

    const subtitle = await adapter.fetchSubtitle(ref, original as NonNullable<typeof original>, auth, signal());
    expect(subtitle.acquisition).toBe("authenticated");
    expect(subtitle.cues.length).toBeGreaterThan(2000);
    expect(subtitle.cues.at(-1)?.endMs ?? 0).toBeGreaterThan(metadata.durationMs * 0.9);

    record("bilibili-lecture-3.parts.json", { partCount: 1, first: part === undefined ? undefined : { index: part.index, title: part.title, durationMs: part.durationMs } });
    record("bilibili-lecture-3.metadata.json", redacted(metadata));
    record("bilibili-lecture-3.subtitle-head.json", { language: subtitle.language, cueCount: subtitle.cues.length, head: subtitle.cues.slice(0, 20) });
  }, 300_000);

  it("YouTube as a guest: metadata and subtitle list of a CC video", async () => {
    const tool = ytDlp();
    const adapter = new YoutubeAdapter({ ytDlp: tool });
    const parsed = adapter.parse(required("AMBER_E2E_YOUTUBE_CC_URL"));
    expect(parsed?.platformContentId).toBeDefined();
    const ref = { platformContentId: parsed?.platformContentId as string };
    const metadata = await adapter.fetchMetadata(ref, undefined, signal());
    expect(metadata.title).not.toBe("");
    expect(metadata.durationMs).toBeGreaterThan(0);
    expect(metadata.subtitleTracks.length).toBeGreaterThan(0);
    for (const candidate of metadata.subtitleTracks) {
      expect(Intl.getCanonicalLocales(candidate.language)[0], candidate.language).toBe(candidate.language);
    }
    record("youtube-cc.metadata.json", redacted(metadata));
    record("youtube-cc.info.redacted.json", redactedInfo(tool.lastJson));

    // The chosen track, downloaded once: rolling auto captions must come out without repeats.
    const track = selectSubtitleTrack(metadata.subtitleTracks, metadata.rawLanguage);
    expect(track).toBeDefined();
    const subtitle = await adapter.fetchSubtitle(ref, track as NonNullable<typeof track>, undefined, signal());
    expect(subtitle.acquisition).toBe("guest");
    expect(subtitle.cues.length).toBeGreaterThan(0);
    const repeats = subtitle.cues.filter((cue, i) => i > 0 && cue.text === subtitle.cues[i - 1]?.text).length;
    expect(repeats).toBe(0);

    // The automatic original track as well, when it was not the one chosen: its VTT is the rolling kind.
    const automatic = metadata.subtitleTracks.find((candidate) => candidate.autoGenerated && !candidate.translated);
    if (automatic !== undefined && automatic.locator !== track?.locator) {
      const rolling = await adapter.fetchSubtitle(ref, automatic, undefined, signal());
      expect(rolling.cues.length).toBeGreaterThan(0);
      expect(rolling.cues.filter((cue, i) => i > 0 && cue.text === rolling.cues[i - 1]?.text).length).toBe(0);
      record("youtube-cc.automatic-head.json", { language: automatic.language, cueCount: rolling.cues.length, head: rolling.cues.slice(0, 20) });
    }
    record("youtube-cc.subtitle-head.json", {
      track: { language: track?.language, autoGenerated: track?.autoGenerated, translated: track?.translated },
      cueCount: subtitle.cues.length,
      head: subtitle.cues.slice(0, 20),
    });
  }, 300_000);

  it("Douyin as a visitor: precheck, metadata, quality tiers and the collection the video belongs to", async () => {
    const adapter = new DouyinAdapter({ http: new DirectOutboundHttpClient() });
    const url = required("AMBER_E2E_DOUYIN_URL");
    const parsed = adapter.parse(url) ?? adapter.parse((await adapter.resolveUrl(url, signal())) ?? "");
    expect(parsed?.platformContentId).toBeDefined();
    const ref = { platformContentId: parsed?.platformContentId as string };

    const check = await adapter.precheck(ref, undefined, signal());
    expect(check.result).toBe("video");
    const metadata = await adapter.fetchMetadata(ref, undefined, signal());
    expect(metadata.title).not.toBe("");
    expect(metadata.durationMs).toBeGreaterThan(0);
    expect(metadata.subtitleTracks).toEqual([]);
    expect((await adapter.listVideoQualities(ref, undefined, signal()))?.length ?? 0).toBeGreaterThan(0);
    expect((await adapter.inspectAudio(ref, undefined, signal())).sizeBytes ?? 0).toBeGreaterThan(0);

    const related = check.result === "video" ? check.relatedCollection : undefined;
    if (related !== undefined) {
      const listing = await adapter.listCollection(related.platformCollectionId, undefined, signal(), COLLECTION_PREVIEW_ITEMS_MAX);
      expect(listing.entries.map((entry) => entry.platformContentId)).toContain(ref.platformContentId);
      expect(listing.title).toBe(related.title);
    }
    // The cover URL is signed: only its host goes into the record.
    record("douyin.metadata.json", { ...metadata, coverUrl: metadata.coverUrl === undefined ? undefined : new URL(metadata.coverUrl).hostname });
  }, 300_000);
});
