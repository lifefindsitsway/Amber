import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsrBanner } from "../../../../src/web/pages/content/asr-banner.tsx";
import { revision, segment } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const primary = revision("m1", { kind: "manual", createdAt: 1_000 });
const fresh = (overrides: Parameters<typeof revision>[1] = {}) => revision("r5", { kind: "asr", createdAt: 5_000, ...overrides });

const recognized = (...speakers: Array<string | undefined>) => ({
  body: {
    revision: fresh(),
    items: speakers.map((speakerId, index) => segment(`n${index}`, index, index * 1_000, index * 1_000 + 900, "句", { revisionId: "r5", ...(speakerId === undefined ? {} : { speakerId }) })),
  },
});

function renderBanner(onApplySpeakers?: (id: string) => void, revisions = [primary, fresh()]) {
  return renderApp(<AsrBanner contentId="c1" revisions={revisions} primaryId="m1" {...(onApplySpeakers === undefined ? {} : { onApplySpeakers })} />);
}

beforeEach(() => localStorage.clear());

describe("AsrBanner and speakers", () => {
  it("offers to apply the speakers first when the new recognition names two or more, keeping 「设为当前」 beside it", async () => {
    mockApi({ "GET /api/transcript/revisions/r5/segments": recognized("spk-1", "spk-2", "spk-1") });
    const onApply = vi.fn();
    renderBanner(onApply);
    const apply = await screen.findByTestId("asr-banner-apply-speakers");
    expect(apply.textContent).toBe("套用发言人到当前版本");
    expect(screen.getByTestId("asr-banner").textContent).toContain("新转录稿识别出 2 位发言人。");
    expect(screen.getByTestId("asr-banner-set-primary").textContent).toBe("设为当前");
    // The speaker action is the main one; switching is the quieter choice.
    expect(apply.className).toContain("bg-accent-glow");
    expect(screen.getByTestId("asr-banner-set-primary").className).not.toContain("bg-accent-glow");
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith("r5");
  });

  it("stays as it was when the recognition names fewer than two speakers", async () => {
    const { calls } = mockApi({ "GET /api/transcript/revisions/r5/segments": recognized("spk-1", "spk-1", undefined) });
    renderBanner(vi.fn());
    await waitFor(() => expect(calls.some((call) => call.path.startsWith("/api/transcript/revisions/r5/segments"))).toBe(true));
    await screen.findByTestId("asr-banner");
    expect(screen.queryByTestId("asr-banner-apply-speakers")).toBeNull();
    expect(screen.getByTestId("asr-banner-set-primary").className).toContain("bg-accent-glow");
  });

  it("without the callback it is unchanged and reads no sentences", async () => {
    const { calls } = mockApi({ "GET /api/transcript/revisions/r5/segments": recognized("spk-1", "spk-2") });
    renderBanner();
    await screen.findByTestId("asr-banner");
    expect(screen.queryByTestId("asr-banner-apply-speakers")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does not look for speakers in a recognition that recorded finding none", async () => {
    const { calls } = mockApi({ "GET /api/transcript/revisions/r5/segments": recognized("spk-1", "spk-2") });
    renderBanner(vi.fn(), [primary, fresh({ generation: { kind: "asr", diarization: { status: "off" } } })]);
    await screen.findByTestId("asr-banner");
    expect(calls).toEqual([]);
    expect(screen.queryByTestId("asr-banner-apply-speakers")).toBeNull();
  });
});
