import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentPageProvider } from "../../../../src/web/pages/content/content-context.tsx";
import { SubtitlesTab } from "../../../../src/web/pages/content/subtitles-tab.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../../src/web/player/player-controller.tsx";
import { contentDetail, contentRoutes } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

function renderSubtitlesWithSelection(method: "lineage" | "none") {
  const { calls } = mockApi({
    ...contentRoutes(),
    "GET /api/transcript/segments/x1/map": { body: method === "none" ? { segmentId: null, method } : { segmentId: "s2", method } },
  });
  const state = { content: contentDetail(), primaryRevisionId: "r1", selection: { revisionId: "other", segmentId: "x1" }, select: vi.fn(), openTab: vi.fn(), highlightThreshold: 80, setHighlightThreshold: vi.fn(), openSubtitleEditor: vi.fn(), navigation: 0, switchRevision: vi.fn() };
  renderApp(
    <PlayerControllerProvider controller={new PlayerController()}>
      <ContentPageProvider value={state}>
        <SubtitlesTab />
      </ContentPageProvider>
    </PlayerControllerProvider>,
  );
  return calls;
}

describe("same-sentence locating", () => {
  it("highlights the mapped sentence of another revision", async () => {
    const calls = renderSubtitlesWithSelection("lineage");
    const row = await screen.findByText("先看向量库。");
    await vi.waitFor(() => expect(row.closest("[data-segment-id]")?.className).toContain("bg-accent-soft"));
    expect(calls.some((call) => call.path === "/api/transcript/segments/x1/map?targetRevision=r1")).toBe(true);
  });

  it("says it cannot locate instead of jumping when the map finds nothing", async () => {
    renderSubtitlesWithSelection("none");
    expect(await screen.findByTestId("locate-unmatched")).toBeTruthy();
  });
});
