import type { Page, Request, Route } from "@playwright/test";
import { contentDetailDtoSchema } from "../../src/shared/dto/content.ts";
import { danmakuFetchResultDtoSchema, danmakuSnapshotDtoSchema, type DanmakuItem, type DanmakuSnapshot } from "../../src/shared/dto/danmaku.ts";
import { errorResponseSchema } from "../../src/shared/errors.ts";
import { CLIP_SERVER_PORT } from "../fixtures/e2e/global-setup.ts";

/** The bilibili lecture of the mock backend; a danmaku setup gives it video caches and a danmaku summary. */
export const DANMAKU_CONTENT = "01J0000000000000000000BL01";
const DANMAKU_BVID = "BV1mock00001";
const BILI_REVISION = "01J0000000000000000000REV2";
/** Two cached qualities of the same clip, so switching quality can be exercised. */
export const DANMAKU_CACHE_HD = "01J0000000000000000000DMHD";
export const DANMAKU_CACHE_SD = "01J0000000000000000000DMSD";
const CLIP_URL = `http://127.0.0.1:${CLIP_SERVER_PORT}/local-player.webm`;
const NOW = 1_790_000_000_000;

/** What the next `POST …/danmaku/fetch` answers. */
export type DanmakuFetchPlan =
  | { result: "fetched"; items: DanmakuItem[]; truncated?: boolean }
  | { result: "empty" }
  | { result: "failed"; userMessage: string }
  | { result: "cooldown"; retryAfterMs: number };

export interface DanmakuMockOptions {
  /** The stored snapshot; absent = never fetched. */
  snapshot?: DanmakuItem[];
  /** Answers of successive fetches; the last one repeats. */
  fetches?: DanmakuFetchPlan[];
  /** Holds every fetch answer until `release()`. */
  hold?: boolean;
  /** Cached video qualities (heights); default one 720P cache. */
  qualities?: number[];
}

export interface MockDanmaku {
  /** `POST …/danmaku/fetch` requests so far. */
  fetchCount(): number;
  /** `GET /api/media/…` requests of the caches so far. */
  mediaRequests(): string[];
  release(): void;
}

interface State {
  options: DanmakuMockOptions;
  snapshot: DanmakuSnapshot | undefined;
  fetches: number;
  media: string[];
  waiting: Array<() => void>;
  held: boolean;
}

const states = new WeakMap<Page, State>();

function snapshotOf(items: readonly DanmakuItem[], fetchedAt: number): DanmakuSnapshot {
  return { fetchedAt, count: items.length, items: [...items].sort((a, b) => a.timeMs - b.timeMs) };
}

/**
 * Gives the mock backend's bilibili lecture what a danmaku test needs: video caches the
 * server mode streams (the mock clip) and a danmaku snapshot with fetch answers planned by
 * the test. Call before `page.goto`, after `installMockBackend` (with `mode: "server"` to
 * play the caches).
 */
export function setupDanmaku(page: Page, options: DanmakuMockOptions = {}): MockDanmaku {
  const state: State = {
    options,
    snapshot: options.snapshot === undefined ? undefined : snapshotOf(options.snapshot, NOW - 3_600_000),
    fetches: 0,
    media: [],
    waiting: [],
    held: options.hold === true,
  };
  states.set(page, state);
  return {
    fetchCount: () => state.fetches,
    mediaRequests: () => [...state.media],
    release: () => {
      state.held = false;
      for (const go of state.waiting.splice(0)) go();
    },
  };
}

function detail(state: State) {
  const qualities = state.options.qualities ?? [720];
  const ids = [DANMAKU_CACHE_HD, DANMAKU_CACHE_SD];
  return contentDetailDtoSchema.parse({
    id: DANMAKU_CONTENT,
    source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${DANMAKU_BVID}`, platformContentId: DANMAKU_BVID, platformPartId: "1" },
    title: "第二讲：B 站模拟课程",
    durationMs: 120_000,
    rawLanguage: "zh-CN",
    primaryTranscriptRevisionId: BILI_REVISION,
    processingStatus: "succeeded",
    collections: [],
    createdAt: NOW,
    updatedAt: NOW,
    danmaku: state.snapshot === undefined ? {} : { fetchedAt: state.snapshot.fetchedAt, count: state.snapshot.count },
    media: qualities.map((height, index) => ({
      id: ids[index],
      kind: "platform_cache",
      displayName: `第二讲 [${height}P].webm`,
      mimeType: "video/webm",
      sizeBytes: 1,
      durationMs: 130_000,
      availability: "available",
      retentionPolicy: "evictable",
      quality: String(height),
      qualityVerified: true,
      createdAt: NOW - index,
    })),
  });
}

/** The mock backend's danmaku routes; answers `false` for any request it does not serve. */
export async function handleDanmaku(route: Route, request: Request, url: URL): Promise<boolean> {
  let page: Page;
  try {
    page = request.frame().page();
  } catch {
    // A request with no frame (a service worker's) is none of a danmaku test's.
    return false;
  }
  const state = states.get(page);
  if (state === undefined) return false;
  const path = url.pathname;
  const method = request.method();
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (method === "GET" && path === `/api/contents/${DANMAKU_CONTENT}`) {
    await json(detail(state));
    return true;
  }
  if (method === "GET" && (path === `/api/media/${DANMAKU_CACHE_HD}` || path === `/api/media/${DANMAKU_CACHE_SD}`)) {
    state.media.push(path);
    await route.continue({ url: CLIP_URL });
    return true;
  }
  if (method === "GET" && path === `/api/contents/${DANMAKU_CONTENT}/danmaku`) {
    await json(danmakuSnapshotDtoSchema.parse({ supported: true, ...(state.snapshot === undefined ? {} : { snapshot: state.snapshot }) }));
    return true;
  }
  if (method === "POST" && path === `/api/contents/${DANMAKU_CONTENT}/danmaku/fetch`) {
    state.fetches += 1;
    if (state.held) await new Promise<void>((go) => state.waiting.push(go));
    const plans = state.options.fetches ?? [{ result: "empty" }];
    const plan = plans[Math.min(state.fetches, plans.length) - 1] as DanmakuFetchPlan;
    const at = NOW + state.fetches * 60_000;
    if (plan.result === "cooldown") {
      await json(
        errorResponseSchema.parse({ error: { class: "rate_limited", code: "rate_limited.danmaku_cooldown", retryDisposition: "never", userMessage: "", details: { retryAfterMs: plan.retryAfterMs } } }),
        429,
      );
      return true;
    }
    if (plan.result === "fetched") state.snapshot = snapshotOf(plan.items, at);
    if (plan.result === "empty") state.snapshot = snapshotOf([], at);
    const answer =
      plan.result === "failed"
        ? { result: "failed", ...(state.snapshot === undefined ? {} : { snapshot: state.snapshot }), error: { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: plan.userMessage } }
        : { result: plan.result, snapshot: state.snapshot, ...(plan.result === "fetched" && plan.truncated === true ? { truncated: true } : {}) };
    await json(danmakuFetchResultDtoSchema.parse(answer));
    return true;
  }
  return false;
}
