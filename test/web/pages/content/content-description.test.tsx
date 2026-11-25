import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOAST_DISMISS_MS } from "../../../../src/shared/defaults.ts";
import type { ContentDetailDto } from "../../../../src/shared/dto/content.ts";
import { ContentDescription, DescriptionFetchButton, useDescriptionFetch } from "../../../../src/web/pages/content/content-description.tsx";
import { useContentDetail } from "../../../../src/web/pages/content/content-data.ts";
import { contentDetail } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { stageRun, task, taskDetail } from "../../../fixtures/web/shell-data.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const LATEST = "GET /api/tasks";
const FETCH = "POST /api/contents/c1/description/fetch";

/** The title row's two description pieces, as the page places them. */
function TitleBits(props: { content: ContentDetailDto }) {
  return (
    <>
      <DescriptionFetchButton content={props.content} />
      <ContentDescription content={props.content} />
    </>
  );
}

function latestTask(status: "running" | "succeeded" | "queued", stageStatus?: "pending" | "running" | "succeeded" | "waiting_configuration") {
  const listed = task("t1", { contentId: "c1", statusProjection: status });
  const routes: Record<string, { body: unknown }> = { [LATEST]: { body: { items: [listed], eventSeq: 0 } } };
  if (stageStatus !== undefined) {
    routes["GET /api/tasks/t1"] = {
      body: taskDetail("t1", [stageRun("t1", "source", stageStatus), stageRun("t1", "asr", stageStatus === "succeeded" ? "waiting_configuration" : "pending")], { contentId: "c1", statusProjection: status }),
    };
  }
  return routes;
}

describe("the title row's description entry", () => {
  it("offers 「获取简介」 for a platform video never checked, with no processing task", async () => {
    mockApi({ [LATEST]: { body: { items: [], eventSeq: 0 } } });
    renderApp(<TitleBits content={contentDetail()} />);
    expect((await screen.findByTestId("content-description-fetch")).textContent).toContain("获取简介");
    expect(screen.queryByTestId("content-description")).toBeNull();
  });

  it("does not offer it for a local file, nor once the description was checked", async () => {
    mockApi({ [LATEST]: { body: { items: [], eventSeq: 0 } } });
    const local = renderApp(<TitleBits content={contentDetail({ source: { kind: "local" } })} />);
    await waitFor(() => expect(screen.queryByTestId("content-description-fetch")).toBeNull());
    local.unmount();
    renderApp(<TitleBits content={contentDetail({ descriptionCheckedAt: 5 })} />);
    // Checked and empty: nothing is shown at all, not even a placeholder.
    await waitFor(() => expect(screen.queryByTestId("content-description-fetch")).toBeNull());
    expect(screen.queryByTestId("content-description")).toBeNull();
    expect(screen.queryByTestId("content-description-status")).toBeNull();
  });

  it("is hidden while the source stage is about to read it, and offered while only transcription waits", async () => {
    mockApi(latestTask("running", "running"));
    const running = renderApp(<TitleBits content={contentDetail()} />);
    // Give the task snapshot time to arrive: the entry must stay hidden after it too.
    await waitFor(() => expect(running.client).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("content-description-fetch")).toBeNull();
    running.unmount();
    vi.unstubAllGlobals();
    mockApi(latestTask("queued", "succeeded"));
    renderApp(<TitleBits content={contentDetail()} />);
    expect(await screen.findByTestId("content-description-fetch")).not.toBeNull();
  });

  it("shows the description found and hides the entry; the platform's answer replaces the detail", async () => {
    const found = contentDetail({ description: "第一行\n第二行 https://example.com/a", descriptionCheckedAt: 9 });
    mockApi({ [LATEST]: { body: { items: [], eventSeq: 0 } }, "GET /api/contents/c1": { body: contentDetail() }, [FETCH]: { body: { result: "found", content: found } } });
    renderApp(<FromCache />);
    fireEvent.click(await screen.findByTestId("content-description-fetch"));
    // The page reads the detail from the cache the answer was written to.
    expect((await screen.findByTestId("content-description-text")).textContent).toContain("第一行");
    expect(screen.queryByTestId("content-description-fetch")).toBeNull();
    // Found says nothing more.
    expect(screen.queryByTestId("content-description-status")).toBeNull();
  });

  it("says once that the platform has no description, then lets the note go", async () => {
    const empty = contentDetail({ descriptionCheckedAt: 9 });
    mockApi({ [LATEST]: { body: { items: [], eventSeq: 0 } }, [FETCH]: { body: { result: "empty", content: empty } } });
    renderApp(<TitleBits content={contentDetail()} />);
    fireEvent.click(await screen.findByTestId("content-description-fetch"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      expect((await screen.findByTestId("content-description-status")).textContent).toContain("原平台没有为这个视频填写简介");
      // It only reports how the click went, so it leaves after the standard delay.
      await act(async () => void (await vi.advanceTimersByTimeAsync(TOAST_DISMISS_MS - 100)));
      expect(screen.getByTestId("content-description-status")).toBeTruthy();
      await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
      expect(screen.queryByTestId("content-description-status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a retry when nothing could be read, and keeps an existing description on a failed refetch", async () => {
    let answer: { status?: number; body: unknown } = { body: { result: "unknown", content: contentDetail() } };
    mockApi({ [LATEST]: { body: { items: [], eventSeq: 0 } }, [FETCH]: () => answer });
    renderApp(<TitleBits content={contentDetail()} />);
    fireEvent.click(await screen.findByTestId("content-description-fetch"));
    expect((await screen.findByTestId("content-description-status")).textContent).toContain("这次没能读到简介，可稍后重试");
    answer = { status: 503, body: { error: { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: "暂时连不上平台" } } };
    fireEvent.click(screen.getByTestId("content-description-retry"));
    expect(await screen.findByText("暂时连不上平台")).not.toBeNull();
  });

  it("keeps the shown description while a refetch fails", async () => {
    const shown = contentDetail({ description: "原有简介", descriptionCheckedAt: 3 });
    mockApi({
      [LATEST]: { body: { items: [], eventSeq: 0 } },
      [FETCH]: { status: 503, body: { error: { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: "暂时连不上平台" } } },
    });
    const view = renderApp(<ContentDescription content={shown} />);
    expect((screen.getByTestId("content-description-text")).textContent).toContain("原有简介");
    // The menu's 「重新获取简介」 runs the same request; trigger it through the shared state.
    view.unmount();
    renderApp(<RefetchHarness content={shown} />);
    fireEvent.click(screen.getByText("refetch"));
    expect(await screen.findByText("暂时连不上平台")).not.toBeNull();
    expect((screen.getByTestId("content-description-text")).textContent).toContain("原有简介");
  });
});


/** Stands in for the ⋯ menu entry: the same fetch, shown through the description's status line. */
function RefetchHarness(props: { content: ContentDetailDto }) {
  const { fetch } = useDescriptionFetch(props.content.id);
  return (
    <>
      <button type="button" onClick={fetch}>
        refetch
      </button>
      <ContentDescription content={props.content} />
    </>
  );
}

/** The title bits fed from the detail query, as the page feeds them. */
function FromCache() {
  const detail = useContentDetail("c1");
  return detail.data === undefined ? null : <TitleBits content={detail.data} />;
}
