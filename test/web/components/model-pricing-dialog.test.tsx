import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PRICE_ITEMS_MAX, PRICE_NOTE_MAX_CHARS, type ModelPricing } from "../../../src/shared/model-pricing.ts";
import { ApiError } from "../../../src/web/api/client.ts";
import { formatPricing, ModelPricingControl, ModelPricingDialog } from "../../../src/web/components/model-pricing-dialog.tsx";
import { initI18n } from "../../../src/web/i18n.ts";
import { renderApp } from "../../fixtures/web/render.tsx";

const t = initI18n().t;

function dialog(props: { scope?: "llm" | "asr" | "other"; pricing?: ModelPricing; onSubmit?: (pricing: ModelPricing | null) => Promise<unknown> } = {}) {
  const onSubmit = vi.fn(props.onSubmit ?? (async () => undefined));
  const onClose = vi.fn();
  renderApp(<ModelPricingDialog modelId="m-1" scope={props.scope ?? "other"} pricing={props.pricing} onSubmit={onSubmit} onClose={onClose} />);
  return { onSubmit, onClose, form: screen.getByTestId("model-pricing-dialog") };
}

const units = (form: HTMLElement, index: number) => [...(within(form).getByLabelText(`计费单位 ${index}`) as HTMLSelectElement).options].map((option) => option.value);

describe("formatPricing", () => {
  it("names every item in one line with the amount as typed, then the note", () => {
    expect(
      formatPricing({ currency: "CNY", items: [{ unit: "input_tokens_per_million", amount: "0.8" }, { unit: "output_tokens_per_million", amount: "2.7" }] }, t),
    ).toBe("0.8 元 / 百万输入 tokens · 2.7 元 / 百万输出 tokens");
    expect(formatPricing({ currency: "CNY", items: [{ unit: "audio_per_second", amount: "0.00022" }] }, t)).toBe("0.00022 元 / 秒");
    expect(formatPricing({ currency: "USD", items: [{ unit: "audio_per_hour", amount: "0.22" }], note: "billed per minute" }, t)).toBe(
      "0.22 美元 / 小时（billed per minute）",
    );
  });
});

describe("ModelPricingDialog", () => {
  it("starts with one item in the section's first unit, keeps units unique and stops at the item limit", () => {
    const { form } = dialog();
    expect(within(form).getAllByTestId("pricing-item")).toHaveLength(1);
    expect((within(form).getByRole("button", { name: "移除计费项 1" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(form).getByLabelText("计费单位 1") as HTMLSelectElement).value).toBe("input_tokens_per_million");
    const add = within(form).getByRole("button", { name: "添加计费项" }) as HTMLButtonElement;
    fireEvent.click(add);
    expect((within(form).getByLabelText("计费单位 2") as HTMLSelectElement).value).toBe("output_tokens_per_million");
    expect(units(form, 2)).not.toContain("input_tokens_per_million");
    expect(units(form, 1)).not.toContain("output_tokens_per_million");
    for (let index = 2; index < PRICE_ITEMS_MAX; index += 1) fireEvent.click(add);
    expect(within(form).getAllByTestId("pricing-item")).toHaveLength(PRICE_ITEMS_MAX);
    expect(add.disabled).toBe(true);
  });

  it("offers only the units of its section, and no more items than units", () => {
    const { form } = dialog({ scope: "llm" });
    expect(units(form, 1)).toEqual([
      "input_tokens_per_million",
      "output_tokens_per_million",
      "cached_input_tokens_per_million",
      "cache_write_tokens_per_million",
      "cache_write_1h_tokens_per_million",
      "per_request",
    ]);
    const add = within(form).getByRole("button", { name: "添加计费项" }) as HTMLButtonElement;
    for (let index = 1; index < 6; index += 1) fireEvent.click(add);
    expect(add.disabled).toBe(true);
  });

  it("refuses a malformed amount or an overlong note, and saves a valid price with the trimmed note", async () => {
    const { form, onSubmit, onClose } = dialog({ scope: "asr" });
    fireEvent.change(within(form).getByLabelText("计费单位 1"), { target: { value: "audio_per_second" } });
    fireEvent.change(within(form).getByLabelText("单价 1"), { target: { value: "1.2.3" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(within(form).getByText("请填写非负数字，最多 10 位小数")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("单价 1"), { target: { value: " 0.00022 " } });
    fireEvent.change(within(form).getByLabelText("备注（可选）"), { target: { value: "x".repeat(PRICE_NOTE_MAX_CHARS + 1) } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(within(form).getByText(`备注最多 ${PRICE_NOTE_MAX_CHARS} 个字符`)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText("备注（可选）"), { target: { value: "  free 2 hours a day " } });
    fireEvent.change(within(form).getByLabelText("币种"), { target: { value: "USD" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({ currency: "USD", items: [{ unit: "audio_per_second", amount: "0.00022" }], note: "free 2 hours a day" });
  });

  it("offers to clear an existing price only, and stays open with the error when saving fails", async () => {
    const failure = new ApiError(400, { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "refused" });
    const { form, onSubmit, onClose } = dialog({
      pricing: { currency: "CNY", items: [{ unit: "per_image", amount: "0.2" }] },
      onSubmit: async () => {
        throw failure;
      },
    });
    expect((within(form).getByLabelText("单价 1") as HTMLInputElement).value).toBe("0.2");
    fireEvent.click(within(form).getByRole("button", { name: "清除价格" }));
    expect(await within(form).findByRole("alert")).toBeTruthy();
    expect(onSubmit).toHaveBeenCalledWith(null);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ModelPricingControl", () => {
  it("shows no price until one is set, and no clear button for it", async () => {
    renderApp(<ModelPricingControl modelId="m-1" scope="other" pricing={undefined} onSubmit={async () => undefined} />);
    expect(screen.getByTestId("model-pricing-summary").textContent).toBe("未设置价格");
    fireEvent.click(screen.getByRole("button", { name: "价格 · m-1" }));
    const form = await screen.findByTestId("model-pricing-dialog");
    expect(within(form).queryByRole("button", { name: "清除价格" })).toBeNull();
  });
});

describe("ModelPricingDialog rules", () => {
  it("names the conflict of audio units in place and refuses to save while it stands", () => {
    const { form, onSubmit } = dialog({ scope: "asr" });
    fireEvent.change(within(form).getByLabelText("计费单位 1"), { target: { value: "audio_per_second" } });
    fireEvent.change(within(form).getByLabelText("单价 1"), { target: { value: "0.00022" } });
    fireEvent.click(within(form).getByRole("button", { name: "添加计费项" }));
    expect(within(form).queryByTestId("pricing-conflict")).toBeNull();
    fireEvent.change(within(form).getByLabelText("计费单位 2"), { target: { value: "audio_per_minute" } });
    fireEvent.change(within(form).getByLabelText("单价 2"), { target: { value: "0.0132" } });
    expect(within(form).getByTestId("pricing-conflict").textContent).toBe("音频只能选一种计费单位：秒、分钟、小时三选一。");
    expect((within(form).getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByRole("button", { name: "移除计费项 2" }));
    expect(within(form).queryByTestId("pricing-conflict")).toBeNull();
    expect((within(form).getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says a transcription price cannot bill tokens and audio at once", () => {
    const { form } = dialog({ scope: "asr" });
    fireEvent.change(within(form).getByLabelText("单价 1"), { target: { value: "1.2" } });
    fireEvent.click(within(form).getByRole("button", { name: "添加计费项" }));
    fireEvent.change(within(form).getByLabelText("计费单位 2"), { target: { value: "audio_per_hour" } });
    expect(within(form).getByTestId("pricing-conflict").textContent).toBe("转录要么按 tokens 计费，要么按音频时长计费，不能同时填写。");
    expect((within(form).getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the conflict of character units", () => {
    const { form } = dialog({ scope: "other" });
    fireEvent.change(within(form).getByLabelText("计费单位 1"), { target: { value: "characters_per_thousand" } });
    fireEvent.click(within(form).getByRole("button", { name: "添加计费项" }));
    fireEvent.change(within(form).getByLabelText("计费单位 2"), { target: { value: "characters_per_million" } });
    expect(within(form).getByTestId("pricing-conflict").textContent).toBe("字符只能选一种计费单位：千字符、万字符、百万字符三选一。");
  });

  it("hints at a missing cache-read price for a model whose calls hit the cache, until the unit is added", () => {
    const onSubmit = vi.fn(async () => undefined);
    renderApp(<ModelPricingDialog modelId="m-1" scope="llm" pricing={undefined} cacheObserved onSubmit={onSubmit} onClose={vi.fn()} />);
    const form = screen.getByTestId("model-pricing-dialog");
    expect(within(form).getByTestId("pricing-cache-hint").textContent).toBe("该模型的调用出现过缓存命中，未填缓存读取单价时这些请求不计入估算费用");
    fireEvent.change(within(form).getByLabelText("计费单位 1"), { target: { value: "cached_input_tokens_per_million" } });
    expect(within(form).queryByTestId("pricing-cache-hint")).toBeNull();
  });

  it("gives no hint when no call has hit the cache", () => {
    const { form } = dialog({ scope: "llm" });
    expect(within(form).queryByTestId("pricing-cache-hint")).toBeNull();
  });

  it("fits the full set of units of an AI model in the item limit and saves it", async () => {
    const { form, onSubmit, onClose } = dialog({ scope: "llm" });
    const add = within(form).getByRole("button", { name: "添加计费项" });
    for (let index = 1; index < PRICE_ITEMS_MAX; index += 1) fireEvent.click(add);
    const items = within(form).getAllByTestId("pricing-item");
    expect(items).toHaveLength(PRICE_ITEMS_MAX);
    items.forEach((_item, index) => fireEvent.change(within(form).getByLabelText(`单价 ${index + 1}`), { target: { value: String(index + 1) } }));
    expect(within(form).queryByTestId("pricing-conflict")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0] as unknown as [ModelPricing])[0].items).toHaveLength(PRICE_ITEMS_MAX);
  });
});
