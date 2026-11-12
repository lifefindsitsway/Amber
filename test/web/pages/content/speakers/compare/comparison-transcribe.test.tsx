import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComparisonTranscribe } from "../../../../../../src/web/pages/content/speakers/compare/comparison-transcribe.tsx";
import { mockApi, renderApp } from "../../../../../fixtures/web/render.tsx";

const profile = (id: string, provider: "dashscope" | "elevenlabs", modelIds: string[]) => ({
  id,
  name: id,
  provider,
  models: modelIds.map((modelId) => ({ modelId, available: true })),
  credentialStatus: "configured",
  hasCredential: true,
  inUse: false,
  createdAt: 1,
});

const PROFILES = { body: { items: [profile("eleven", "elevenlabs", ["scribe_v2"]), profile("typed", "dashscope", ["fun-asr-2026"])] } };
const URL = "/api/contents/c1/transcript/retranscribe";
const key = (asrProfileId: string, modelId: string) => JSON.stringify([asrProfileId, modelId]);

describe("ComparisonTranscribe", () => {
  it("offers only models that identify speakers and sends nothing before the explicit click", async () => {
    const { calls } = mockApi({ "GET /api/asr-profiles": PROFILES, [`POST ${URL}`]: { status: 202, body: { taskId: "t1" } } });
    renderApp(<ComparisonTranscribe contentId="c1" durationMs={600_000} />);
    const select = (await screen.findByTestId("comparison-model")) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", key("eleven", "scribe_v2")]);
    const submit = screen.getByTestId("comparison-transcribe-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe("用另一家模型再识别一次");
    expect(screen.getByText("这是一次付费转录，结果只用于对比，不会替换当前字幕稿")).toBeTruthy();

    fireEvent.change(select, { target: { value: key("eleven", "scribe_v2") } });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(submit);
    await screen.findByTestId("comparison-transcribe-submitted");
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(URL);
    expect(posts[0]?.body).toEqual({ asrModelRef: { asrProfileId: "eleven", modelId: "scribe_v2" }, diarization: { mode: "required" }, comparison: true });
    expect(posts[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("shows the room left and the room needed when the Content has too few speaker places", async () => {
    mockApi({
      "GET /api/asr-profiles": PROFILES,
      [`POST ${URL}`]: {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.speaker_capacity", retryDisposition: "never", userMessage: "名额不足", details: { room: 3, required: 4 } } },
      },
    });
    renderApp(<ComparisonTranscribe contentId="c1" />);
    fireEvent.change(await screen.findByTestId("comparison-model"), { target: { value: key("eleven", "scribe_v2") } });
    fireEvent.click(screen.getByTestId("comparison-transcribe-submit"));
    await waitFor(() => expect(screen.getByTestId("comparison-capacity").textContent).toBe("这个内容的发言人名额不足：剩余 3 个，对比识别需要 4 个。可先删除不再需要的对比稿"));
  });

  it("shows a refusal of speaker identification as the server words it", async () => {
    mockApi({
      "GET /api/asr-profiles": PROFILES,
      [`POST ${URL}`]: {
        status: 400,
        body: { error: { class: "invalid_request", code: "invalid_request.diarization_unavailable", retryDisposition: "never", userMessage: "无法按要求识别发言人", details: { reason: "unsupported" } } },
      },
    });
    renderApp(<ComparisonTranscribe contentId="c1" />);
    fireEvent.change(await screen.findByTestId("comparison-model"), { target: { value: key("eleven", "scribe_v2") } });
    fireEvent.click(screen.getByTestId("comparison-transcribe-submit"));
    expect((await screen.findByRole("alert")).textContent).toContain("无法按要求识别发言人");
  });

  it("holds back a length the model recommends against", async () => {
    mockApi({ "GET /api/asr-profiles": { body: { items: [profile("fun", "dashscope", ["fun-asr"])] } } });
    renderApp(<ComparisonTranscribe contentId="c1" durationMs={10 * 3_600_000} />);
    fireEvent.change(await screen.findByTestId("comparison-model"), { target: { value: key("fun", "fun-asr") } });
    expect((screen.getByTestId("comparison-transcribe-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("points to the settings when no model identifies speakers", async () => {
    mockApi({ "GET /api/asr-profiles": { body: { items: [profile("typed", "dashscope", ["fun-asr-2026"])] } } });
    renderApp(<ComparisonTranscribe contentId="c1" />);
    expect((await screen.findByTestId("comparison-transcribe-none")).querySelector("a")?.getAttribute("href")).toBe("/settings/transcription");
  });
});
