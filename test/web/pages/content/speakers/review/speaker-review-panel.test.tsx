import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SPEAKER_REVIEW_SAMPLES_PER_SPEAKER } from "../../../../../../src/shared/defaults.ts";
import type { SpeakerReviewDto } from "../../../../../../src/shared/dto/transcript.ts";
import { CAPABILITIES } from "../../../../../../src/web/player/capabilities.ts";
import { PlayerController, PlayerControllerProvider } from "../../../../../../src/web/player/player-controller.tsx";
import type { SampleListSentence } from "../../../../../../src/web/pages/content/speakers/review/review-sample-list.tsx";
import { SpeakerReviewControl, SpeakerReviewPanel } from "../../../../../../src/web/pages/content/speakers/review/speaker-review-panel.tsx";
import { renderApp } from "../../../../../fixtures/web/render.tsx";
import { stubFetch, stubResizeObserver, type FetchCall } from "../../../../../fixtures/web/speaker-fetch.ts";

const REVIEW_PATH = "/api/transcript/revisions/r1/speaker-review";
const CONFIRM_PATH = "/api/transcript/revisions/r1/speakers-confirmed";

const SPEAKERS = [
  { id: "sa", ordinal: 1, name: "陈明", colorIndex: 0, used: true, nameConfirmed: true },
  { id: "sb", ordinal: 2, name: "李雪", colorIndex: 1, used: true },
  { id: "sc", ordinal: 3, colorIndex: 2, used: true },
];

const REVIEW: SpeakerReviewDto = {
  revisionId: "r1",
  rosterDigest: "digest-1",
  // Order of first appearance: 李雪 speaks first.
  speakers: [
    { id: "sb", sentences: 12, assignedMs: 60_000 },
    { id: "sa", sentences: 30, assignedMs: 139_500 },
    { id: "sc", sentences: 1, assignedMs: 500 },
  ],
  unassigned: 4,
  pendingNames: 1,
};

/** Seven sentences per speaker, interleaved, plus an unassigned one. */
const SENTENCES: SampleListSentence[] = Array.from({ length: 22 }, (_unused, index) => {
  const speakerId = index === 21 ? undefined : (["sb", "sa", "sc"][index % 3] as string);
  return { id: `g${index}`, startMs: index * 4_000, endMs: index * 4_000 + 3_000, text: `第 ${index} 句`, ...(speakerId === undefined ? {} : { speakerId }) };
});

function routes(review: SpeakerReviewDto, extra: Parameters<typeof stubFetch>[0] = {}) {
  return stubFetch({
    [`GET ${REVIEW_PATH}`]: { json: review },
    "GET /api/contents/c1/speakers": { json: { items: SPEAKERS } },
    ...extra,
  });
}

function showControl(options: { speakerMode?: boolean; onLocate?: (id: string) => void; controller?: PlayerController; crossCheck?: string } = {}) {
  const controller = options.controller ?? new PlayerController();
  return renderApp(
    <PlayerControllerProvider controller={controller}>
      <SpeakerReviewControl
        contentId="c1"
        revisionId="r1"
        speakerMode={options.speakerMode ?? true}
        sentences={SENTENCES}
        onLocate={options.onLocate ?? (() => undefined)}
        {...(options.crossCheck === undefined ? {} : { crossCheck: <p>{options.crossCheck}</p> })}
      />
    </PlayerControllerProvider>,
  );
}

async function openPanel(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByTestId("speaker-review-badge").textContent).not.toBe(""));
  fireEvent.click(screen.getByTestId("speaker-review-badge"));
  const panel = await screen.findByTestId("speaker-review-panel");
  await within(panel).findByTestId("speaker-review-roster");
  return panel;
}

beforeEach(() => {
  stubResizeObserver();
});

describe("SpeakerReviewControl", () => {
  it("shows nothing and asks for nothing outside speaker mode", async () => {
    const calls = routes(REVIEW);
    showControl({ speakerMode: false });
    await act(async () => undefined);
    expect(screen.queryByTestId("speaker-review-badge")).toBeNull();
    expect(calls.some((call) => call.path === REVIEW_PATH)).toBe(false);
  });

  it("states the review in words and as its accessible name, and opens the panel from the keyboard", async () => {
    routes({ ...REVIEW, confirmedAt: 1_700_000_000_000 });
    showControl();
    const badge = await screen.findByTestId("speaker-review-badge");
    await waitFor(() => expect(badge.textContent).toBe("已核对 · 1 个姓名待确认"));
    expect(badge.getAttribute("aria-label")).toBe("发言人核对状态：已核对 · 1 个姓名待确认。打开核对面板");
    expect(badge.getAttribute("aria-haspopup")).toBe("dialog");
    expect(badge.tagName).toBe("BUTTON");
    badge.focus();
    fireEvent.click(badge);
    const panel = await screen.findByTestId("speaker-review-popover");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-labelledby")).toBe(within(panel).getByText("核对发言人").id);
  });

  it("shows the title, the three counts from the review and no count of unsure sentences", async () => {
    routes(REVIEW);
    showControl();
    expect((await screen.findByTestId("speaker-review-badge")).textContent).toBe("发言人未核对");
    const panel = await openPanel();
    expect(within(panel).getByText("当前字幕稿 · 只核对谁说的")).toBeTruthy();
    expect(within(panel).getByTestId("speaker-review-stat-speakers").textContent).toBe("发言人3");
    expect(within(panel).getByTestId("speaker-review-stat-unassigned").textContent).toBe("未分配句4");
    expect(within(panel).getByTestId("speaker-review-stat-pending-names").textContent).toBe("姓名待确认1");
    expect(panel.textContent).not.toContain("待确认句");
    // Optional lines only when there is something to say.
    expect(within(panel).queryByTestId("speaker-review-accepted")).toBeNull();
    expect(within(panel).queryByTestId("speaker-review-draft")).toBeNull();
    expect(within(panel).getByTestId("speaker-review-disclaimer").textContent).toBe("确认表示你已检查这份字幕稿的发言人归属，不代表文字已校对");
  });

  it("adds the accepted-suggestion and draft lines when the review has them", async () => {
    routes({ ...REVIEW, acceptedSuggestions: 6, draftNeedsReview: 9 });
    showControl();
    const panel = await openPanel();
    expect(within(panel).getByTestId("speaker-review-accepted").textContent).toBe("6 句按建议归属");
    expect(within(panel).getByTestId("speaker-review-draft").textContent).toBe("草稿里还有 9 句待处理");
  });

  it("lists the roster in order of appearance with sentences, share of assigned time and unconfirmed names, and locates a first turn", async () => {
    routes(REVIEW);
    const onLocate = vi.fn();
    showControl({ onLocate });
    const panel = await openPanel();
    const rows = within(panel).getAllByTestId("speaker-review-roster-row");
    expect(rows.map((row) => row.getAttribute("data-speaker-id"))).toEqual(["sb", "sa", "sc"]);
    expect(rows[0]?.textContent).toContain("李雪");
    expect(rows[0]?.textContent).toContain("12 句 · 占已标注时长 30%");
    expect(rows[1]?.textContent).toContain("30 句 · 占已标注时长 70%");
    expect(rows[2]?.textContent).toContain("发言人 3");
    expect(rows[2]?.textContent).toContain("占已标注时长不足 1%");
    // The name is shown as unconfirmed in words, only for a named speaker whose name is not confirmed.
    expect(within(rows[0] as HTMLElement).getByTestId("speaker-review-name-pending").textContent).toBe("姓名待确认");
    expect(within(rows[1] as HTMLElement).queryByTestId("speaker-review-name-pending")).toBeNull();
    expect(within(rows[2] as HTMLElement).queryByTestId("speaker-review-name-pending")).toBeNull();
    const locate = within(rows[1] as HTMLElement).getByRole("button", { name: "定位到 陈明 的第一轮" });
    fireEvent.click(locate);
    expect(onLocate).toHaveBeenCalledWith("g1");
    await waitFor(() => expect(screen.queryByTestId("speaker-review-panel")).toBeNull());
  });

  it("folds 「辅助核对」 by default; unfolded it plays sampled clips as ranges and shows the cross-check summary", async () => {
    routes(REVIEW);
    const controller = new PlayerController();
    const driver = { capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn(), pause: vi.fn() };
    controller.attach(driver);
    showControl({ controller, crossCheck: "交叉识别摘要" });
    const panel = await openPanel();
    const toggle = within(panel).getByTestId("speaker-review-assist-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(panel).queryByTestId("speaker-review-samples")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const groups = within(panel).getAllByTestId("speaker-review-sample-group");
    expect(groups.map((group) => group.getAttribute("data-speaker-id"))).toEqual(["sb", "sa", "sc"]);
    expect(within(groups[0] as HTMLElement).getAllByTestId("speaker-review-sample")).toHaveLength(SPEAKER_REVIEW_SAMPLES_PER_SPEAKER);
    const play = within(groups[1] as HTMLElement).getAllByRole("button", { name: /^播放 陈明 在 / });
    expect(play[0]?.textContent).toBe("播放");
    const spy = vi.spyOn(controller, "playRange");
    fireEvent.click(play[0] as HTMLElement);
    expect(spy).toHaveBeenCalledWith(4_000, 7_000);
    expect(driver.seek).toHaveBeenCalledWith(4_000);
    expect(await within(panel).findByTestId("speaker-review-sample-playing")).toBeTruthy();
    expect(within(panel).getByTestId("speaker-review-cross-check").textContent).toBe("交叉识别摘要");
  });

  it("reads 「跳到」 with a player that can only jump, and offers no listening without a player", async () => {
    routes(REVIEW);
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.bilibili, seek: vi.fn() });
    const { unmount } = showControl({ controller });
    let panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("speaker-review-assist-toggle"));
    expect(within(panel).getByTestId("speaker-review-samples-jump-only")).toBeTruthy();
    const jumps = within(panel).getAllByTestId("speaker-review-sample-play");
    expect(jumps[0]?.textContent).toBe("跳到");
    expect(jumps[0]?.getAttribute("aria-label")).toMatch(/^跳到 李雪 在 /);
    unmount();

    routes(REVIEW);
    showControl({ controller: new PlayerController() });
    panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("speaker-review-assist-toggle"));
    expect(within(panel).getByTestId("speaker-review-samples-no-player")).toBeTruthy();
    expect(within(panel).queryAllByTestId("speaker-review-sample-play")).toHaveLength(0);
  });

  it("has no paid entry point: its only buttons locate, unfold, play and confirm", async () => {
    routes(REVIEW);
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn(), pause: vi.fn() });
    showControl({ controller });
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("speaker-review-assist-toggle"));
    const kinds = new Set(within(panel).getAllByRole("button").map((button) => button.getAttribute("data-testid")));
    expect([...kinds].sort()).toEqual(["speaker-review-assist-toggle", "speaker-review-confirm", "speaker-review-locate", "speaker-review-sample-play"]);
  });
});

describe("SpeakerReviewPanel confirmation", () => {
  function showPanel() {
    return renderApp(<SpeakerReviewPanel contentId="c1" revisionId="r1" sentences={SENTENCES} onLocate={() => undefined} />);
  }

  it("confirms with the roster digest it showed, then shows the time and takes the mark back", async () => {
    let current: SpeakerReviewDto = REVIEW;
    const calls = routes(REVIEW, {
      [`GET ${REVIEW_PATH}`]: () => ({ json: current }),
      [`PUT ${CONFIRM_PATH}`]: (call: FetchCall) => {
        const body = call.body as { confirmed: boolean };
        current = body.confirmed ? { ...REVIEW, confirmedAt: 1_700_000_000_000, pendingNames: 0 } : { ...REVIEW, pendingNames: 0 };
        return { json: current };
      },
    });
    showPanel();
    fireEvent.click(await screen.findByTestId("speaker-review-confirm"));
    await screen.findByTestId("speaker-review-confirmed-at");
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ confirmed: true, expectedRosterDigest: "digest-1" });
    expect(screen.getByTestId("speaker-review-confirmed-at").textContent).toMatch(/^已于 .+ 核对$/);
    fireEvent.click(screen.getByTestId("speaker-review-unconfirm"));
    await screen.findByTestId("speaker-review-confirm");
    expect(calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({ confirmed: false });
  });

  it("refuses a stale roster: reads it again, says it changed and confirms nothing", async () => {
    let reads = 0;
    const calls = routes(REVIEW, {
      [`GET ${REVIEW_PATH}`]: () => {
        reads += 1;
        return { json: reads === 1 ? REVIEW : { ...REVIEW, rosterDigest: "digest-2" } };
      },
      [`PUT ${CONFIRM_PATH}`]: {
        status: 409,
        json: { error: { class: "conflict", code: "conflict.speakers_changed", retryDisposition: "never", userMessage: "" } },
      },
    });
    showPanel();
    fireEvent.click(await screen.findByTestId("speaker-review-confirm"));
    const alert = await screen.findByTestId("speaker-review-roster-changed");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("发言人名单刚刚有变化，已重新读取，请检查后再标记为已核对");
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId("speaker-review-confirmed-at")).toBeNull();
    // The next confirmation names the roster read again.
    await waitFor(() => expect((screen.getByTestId("speaker-review-confirm") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("speaker-review-confirm"));
    await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({ confirmed: true, expectedRosterDigest: "digest-2" });
  });

  it("says when the review cannot be read", async () => {
    stubFetch({ "GET /api/contents/c1/speakers": { json: { items: SPEAKERS } } });
    showPanel();
    expect((await screen.findByRole("alert")).textContent).toBe("无法读取发言人核对信息");
  });
});
