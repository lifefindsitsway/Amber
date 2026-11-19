import { describe, expect, it } from "vitest";
import { DANMAKU_FIXED_MS, DANMAKU_ONSCREEN_MAX, DANMAKU_QUEUE_MAX, DANMAKU_SCROLL_MS } from "../../../src/shared/defaults.ts";
import type { DanmakuItem, DanmakuMode } from "../../../src/shared/dto/danmaku.ts";
import { DANMAKU_MAX_WAIT_MS, DanmakuScheduler, fitsBehind, type DanmakuStage } from "../../../src/web/player/danmaku-scheduler.ts";

const STAGE: DanmakuStage = { width: 800, height: 260, laneHeight: 26, gap: 20 };
const LANES = STAGE.height / STAGE.laneHeight;
/** Ten pixels per character, so widths are easy to reason about. */
const measure = (text: string): number => text.length * 10;

function item(timeMs: number, text = "弹幕", mode: DanmakuMode = "scroll", weight = 5): DanmakuItem {
  return { timeMs, mode, color: 0xffffff, weight, text };
}

function scheduler(items: readonly DanmakuItem[], stage: DanmakuStage = STAGE): DanmakuScheduler {
  const result = new DanmakuScheduler();
  result.setStage(stage, measure, 0);
  // Just before 0, so items at 0 are still to come.
  result.replaceItems(items, -1);
  return result;
}

/** Where a scrolling item's left edge is at `atMs`. */
function leftAt(startMs: number, width: number, atMs: number): number {
  return STAGE.width - ((STAGE.width + width) / DANMAKU_SCROLL_MS) * (atMs - startMs);
}

describe("DanmakuScheduler lanes", () => {
  it("never lets a scrolling item run into or catch up with the one ahead of it in its lane", () => {
    // Bursts of short and long items arriving together: every pair sharing a lane stays apart for their whole crossing.
    const items: DanmakuItem[] = [];
    for (let second = 0; second < 20; second += 1) {
      for (let k = 0; k < 6; k += 1) items.push(item(second * 1000 + k * 37, "x".repeat(2 + ((second * 7 + k * 5) % 30))));
    }
    const subject = scheduler(items);
    const placed = new Map<number, Array<{ startMs: number; width: number }>>();
    for (let now = 0; now <= 30_000; now += 50) {
      for (const shown of subject.advance(now).added) {
        const lane = placed.get(shown.y) ?? [];
        lane.push({ startMs: shown.startMs, width: shown.width });
        placed.set(shown.y, lane);
      }
    }
    expect(placed.size).toBeGreaterThan(1);
    for (const lane of placed.values()) {
      for (let index = 1; index < lane.length; index += 1) {
        const ahead = lane[index - 1] as { startMs: number; width: number };
        const behind = lane[index] as { startMs: number; width: number };
        for (let t = behind.startMs; t <= ahead.startMs + DANMAKU_SCROLL_MS; t += 25) {
          expect(leftAt(behind.startMs, behind.width, t)).toBeGreaterThanOrEqual(leftAt(ahead.startMs, ahead.width, t) + ahead.width - 1e-6);
        }
      }
    }
  });

  it("checks both the entry gap and a faster newcomer catching up", () => {
    const tail = { startMs: 0, width: 100, speed: (STAGE.width + 100) / DANMAKU_SCROLL_MS };
    const needed = (tail.width + STAGE.gap) / tail.speed;
    expect(fitsBehind(tail, needed - 1, 100, tail.speed, STAGE)).toBe(false);
    expect(fitsBehind(tail, needed, 100, tail.speed, STAGE)).toBe(true);
    // A much longer item is faster: right after the gap opens it would still catch up.
    const fast = (STAGE.width + 700) / DANMAKU_SCROLL_MS;
    expect(fitsBehind(tail, needed, 700, fast, STAGE)).toBe(false);
    expect(fitsBehind(tail, DANMAKU_SCROLL_MS - STAGE.width / fast, 700, fast, STAGE)).toBe(true);
  });

  it("takes the topmost free lane, stacks top items downwards and bottom items upwards, each held DANMAKU_FIXED_MS", () => {
    const subject = scheduler([item(0, "a", "top"), item(0, "b", "top"), item(0, "c", "bottom"), item(0, "d", "bottom")]);
    const added = subject.advance(0).added;
    expect(added.map((shown) => [shown.item.text, shown.y, shown.durationMs])).toEqual([
      ["a", 0, DANMAKU_FIXED_MS],
      ["b", STAGE.laneHeight, DANMAKU_FIXED_MS],
      ["c", STAGE.height - STAGE.laneHeight, DANMAKU_FIXED_MS],
      ["d", STAGE.height - 2 * STAGE.laneHeight, DANMAKU_FIXED_MS],
    ]);
    // The lanes free up once their items have left.
    expect(subject.advance(DANMAKU_FIXED_MS).removed).toHaveLength(4);
  });

  it("keeps scrolling items off lanes a top or bottom item is held over, and holds those where nothing scrolls when it can", () => {
    const subject = scheduler([item(0, "s1"), item(0, "top", "top"), item(100, "s2"), item(5000, "s3")]);
    const first = subject.advance(0).added;
    // The top item avoids the lane the first scrolling one crosses.
    expect(first.map((shown) => [shown.item.text, shown.y])).toEqual([
      ["s1", 0],
      ["top", STAGE.laneHeight],
    ]);
    // The second scrolling item cannot follow s1 yet and skips the held lane.
    expect(subject.advance(100).added.map((shown) => [shown.item.text, shown.y])).toEqual([["s2", 2 * STAGE.laneHeight]]);
    // Once the top item has gone, its lane is free for scrolling again.
    expect(subject.advance(DANMAKU_FIXED_MS + 1000).added.map((shown) => shown.item.text)).toEqual(["s3"]);
  });

  it("places no new item on a lane crossing the avoided band, and leaves what is on screen alone", () => {
    const subject = scheduler(Array.from({ length: LANES * 2 }, (_, index) => item(index < LANES ? 0 : 100, `x${index}`, "top")));
    subject.setAvoid({ top: 60, bottom: 140 });
    const first = subject.advance(0).added.map((shown) => shown.y);
    expect(first.length).toBeGreaterThan(0);
    for (const y of first) expect(y + STAGE.laneHeight <= 60 || y >= 140).toBe(true);
    subject.setAvoid(undefined);
    expect(subject.onScreen().map((shown) => shown.y)).toEqual(first);
  });
});

describe("DanmakuScheduler limits", () => {
  it("never has more than DANMAKU_ONSCREEN_MAX on screen nor more than DANMAKU_QUEUE_MAX waiting", () => {
    const tall: DanmakuStage = { width: 4000, height: 26 * 400, laneHeight: 26, gap: 20 };
    const items = Array.from({ length: 3000 }, (_, index) => item(Math.floor(index / 500) * 10, `item ${index}`));
    const subject = scheduler(items, tall);
    let peak = 0;
    for (let now = 0; now <= 2 * DANMAKU_SCROLL_MS; now += 16) {
      subject.advance(now);
      peak = Math.max(peak, subject.onScreen().length);
      expect(subject.onScreen().length).toBeLessThanOrEqual(DANMAKU_ONSCREEN_MAX);
      expect(subject.queued()).toBeLessThanOrEqual(DANMAKU_QUEUE_MAX);
    }
    expect(peak).toBe(DANMAKU_ONSCREEN_MAX);
  });

  it("drops the oldest waiting items first, and any that waited DANMAKU_MAX_WAIT_MS", () => {
    // One lane, many items at once: one shows, the rest wait, capped.
    const oneLane: DanmakuStage = { width: 800, height: 26, laneHeight: 26, gap: 20 };
    const items = Array.from({ length: DANMAKU_QUEUE_MAX + 50 }, (_, index) => item(index, `w${index}`));
    const subject = scheduler(items, oneLane);
    const now = DANMAKU_QUEUE_MAX + 50;
    // The queue keeps the newest DANMAKU_QUEUE_MAX: the first 50 are gone before a lane is even sought.
    expect(subject.advance(now).added.map((shown) => shown.item.text)).toEqual(["w50"]);
    expect(subject.queued()).toBe(DANMAKU_QUEUE_MAX - 1);
    // Once the lane has room again, the oldest item still waiting goes next.
    expect(subject.advance(now + 500).added.map((shown) => shown.item.text)).toEqual(["w51"]);
    // Items that waited too long are dropped rather than shown out of step.
    expect(subject.advance(now + DANMAKU_MAX_WAIT_MS + 1).added).toEqual([]);
    expect(subject.queued()).toBe(0);
  });
});

describe("DanmakuScheduler time", () => {
  it("lays the screen out again after a seek: what covers the new time shows partway through, nothing before it", () => {
    const items = [item(1000, "early"), item(20_000, "covering"), item(25_000, "now", "top"), item(25_001, "later")];
    const subject = scheduler(items);
    const change = subject.reset(25_000);
    expect(change.cleared).toBe(true);
    expect(change.added.map((shown) => [shown.item.text, shown.startMs])).toEqual([
      ["covering", 20_000],
      ["now", 25_000],
    ]);
    // Moving on shows the next one; going backwards lays out afresh.
    expect(subject.advance(25_001).added.map((shown) => shown.item.text)).toEqual(["later"]);
    const back = subject.advance(1500);
    expect(back.cleared).toBe(true);
    expect(back.added.map((shown) => shown.item.text)).toEqual(["early"]);
  });

  it("keeps a new list's items from the current time on, without clearing the screen", () => {
    const subject = scheduler([item(0, "old")]);
    subject.advance(0);
    subject.replaceItems([item(0, "new before"), item(500, "new after")], 100);
    const change = subject.advance(600);
    expect(change.cleared).toBe(false);
    expect(subject.onScreen().map((shown) => shown.item.text)).toEqual(["old", "new after"]);
  });

  it("holds scrolling items at the top instead when motion is reduced", () => {
    const subject = scheduler([item(0, "s")]);
    const change = subject.setStaticOnly(true, 0);
    expect(change.added.map((shown) => [shown.mode, shown.durationMs])).toEqual([["top", DANMAKU_FIXED_MS]]);
  });

  it("shows nothing without a stage", () => {
    const subject = new DanmakuScheduler();
    subject.replaceItems([item(0)], -1);
    expect(subject.advance(10).added).toEqual([]);
  });
});
