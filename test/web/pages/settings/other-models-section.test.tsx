import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PRICE_UNITS } from "../../../../src/shared/model-pricing.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { OtherModelsSection } from "../../../../src/web/pages/settings/other-models-section.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const VOICES = {
  id: "o1",
  name: "Voices",
  note: "TTS for narration\nsecond line",
  models: [
    { modelId: "tts-1", kind: "tts", pricing: { currency: "USD", items: [{ unit: "characters_per_million", amount: "15" }] } },
    { modelId: "img/flux", kind: "image_generation" },
  ],
  createdAt: 1,
};
const VIDEO = { id: "o2", name: "Video", models: [{ modelId: "veo", kind: "video_generation" }], createdAt: 2 };

describe("OtherModelsSection", () => {
  // Folding is remembered per browser; every case starts unfolded.
  beforeEach(() => localStorage.removeItem("amber.settings.collapsedOtherModels"));

  it("says nothing calls these models and offers to add a first profile", async () => {
    mockApi({ "GET /api/other-models": { body: { items: [] } } });
    renderApp(<OtherModelsSection />);
    expect(await screen.findByText("还没有登记模型")).toBeTruthy();
    expect(screen.getByTestId("other-models-intro").textContent).toContain("只登记模型与价格，Amber 目前没有功能会调用这些模型");
    expect(screen.queryByText("API Key")).toBeNull();
  });

  it("shows each profile's note and models with their kind and price, and edits a price with every unit", async () => {
    const api = mockApi({
      "GET /api/other-models": { body: { items: [VOICES] } },
      "PUT /api/other-models/o1/model-pricing": { body: VOICES },
    });
    renderApp(<OtherModelsSection />);
    expect((await screen.findByTestId("other-model-profile-note")).textContent).toBe("TTS for narration\nsecond line");
    const [tts, image] = screen.getAllByTestId("other-model") as [HTMLElement, HTMLElement];
    expect(within(tts).getByText("语音合成")).toBeTruthy();
    expect(within(tts).getByTestId("model-pricing-summary").textContent).toBe("15 美元 / 百万字符");
    expect(within(image).getByText("图片生成")).toBeTruthy();
    expect(within(image).getByTestId("model-pricing-summary").textContent).toBe("未设置价格");
    // No key, no connection test.
    expect(screen.queryByRole("button", { name: /测试连接/ })).toBeNull();

    fireEvent.click(within(image).getByRole("button", { name: "价格 · img/flux" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("计费单位 1") as HTMLSelectElement).options).toHaveLength(PRICE_UNITS.length);
    fireEvent.change(within(dialog).getByLabelText("计费单位 1"), { target: { value: "per_image" } });
    fireEvent.change(within(dialog).getByLabelText("单价 1"), { target: { value: "0.2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ modelId: "img/flux", pricing: { currency: "CNY", items: [{ unit: "per_image", amount: "0.2" }] } }),
    );
  });

  it("adds a profile with a note and ordered models of a chosen kind, refusing repeated ids", async () => {
    const api = mockApi({
      "GET /api/other-models": { body: { items: [] } },
      "POST /api/other-models": { status: 201, body: VIDEO },
    });
    renderApp(<OtherModelsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "添加 Profile" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: " Studio " } });
    fireEvent.change(within(dialog).getByLabelText("备注（可选）"), { target: { value: " pay as you go " } });
    const ids = () => within(dialog).getAllByLabelText("模型 ID") as HTMLInputElement[];
    const kinds = () => within(dialog).getAllByLabelText("类型") as HTMLSelectElement[];
    fireEvent.change(ids()[0] as HTMLElement, { target: { value: "veo" } });
    expect([...(kinds()[0] as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["语音合成", "图片生成", "视频生成", "其他"]);
    fireEvent.change(kinds()[0] as HTMLElement, { target: { value: "video_generation" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加模型" }));
    await waitFor(() => expect(ids()).toHaveLength(2));
    fireEvent.change(ids()[1] as HTMLElement, { target: { value: "veo" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(within(dialog).getAllByText("模型 ID 重复").length).toBeGreaterThan(0);
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.change(ids()[1] as HTMLElement, { target: { value: "sora" } });
    fireEvent.change(kinds()[1] as HTMLElement, { target: { value: "other" } });
    // The second model moves first.
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "拖动调整模型顺序 · sora" }), { key: "ArrowUp" });
    await waitFor(() => expect(ids().map((input) => input.value)).toEqual(["sora", "veo"]));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        name: "Studio",
        note: "pay as you go",
        models: [
          { modelId: "sora", kind: "other" },
          { modelId: "veo", kind: "video_generation" },
        ],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears a profile's note on edit and keeps the model list as a whole", async () => {
    const api = mockApi({
      "GET /api/other-models": { body: { items: [VOICES] } },
      "PATCH /api/other-models/o1": { body: VOICES },
    });
    renderApp(<OtherModelsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "编辑 Profile" })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("备注（可选）"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
        name: "Voices",
        note: null,
        models: [
          { modelId: "tts-1", kind: "tts" },
          { modelId: "img/flux", kind: "image_generation" },
        ],
      }),
    );
  });

  it("saves a new profile order when one is moved, folds a profile for good, and asks before deleting", async () => {
    const api = mockApi({
      "GET /api/other-models": { body: { items: [VOICES, VIDEO] } },
      "PUT /api/other-models/order": { body: { items: [VIDEO, VOICES] } },
      "DELETE /api/other-models/o2": { status: 204 },
    });
    renderApp(<OtherModelsSection />);
    const names = () => screen.getAllByTestId("other-model-profile-card").map((card) => card.dataset["profile"]);
    await waitFor(() => expect(names()).toEqual(["Voices", "Video"]));
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动调整「Video」的顺序" }), { key: "ArrowUp" });
    await waitFor(() => expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ profileIds: ["o2", "o1"] }));
    await waitFor(() => expect(names()).toEqual(["Video", "Voices"]));

    const voices = screen.getAllByTestId("other-model-profile-card")[1] as HTMLElement;
    fireEvent.click(within(voices).getByRole("button", { name: "收起「Voices」" }));
    expect(within(voices).queryByTestId("other-model")).toBeNull();
    expect(within(voices).getByText("2 个模型")).toBeTruthy();
    expect(localStorage.getItem("amber.settings.collapsedOtherModels")).toBe(JSON.stringify(["o1"]));

    const video = screen.getAllByTestId("other-model-profile-card")[0] as HTMLElement;
    fireEvent.click(within(video).getByRole("button", { name: "删除" }));
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "DELETE" && call.path === "/api/other-models/o2")).toBe(true));
  });
});
