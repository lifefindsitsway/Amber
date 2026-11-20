import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ModelRefDto } from "../../../src/shared/dto/model-ref.ts";
import type { ProviderProfileDto } from "../../../src/shared/dto/provider.ts";
import { ContextWindowNotice } from "../../../src/web/models/context-window-notice.tsx";
import { useModelReadiness } from "../../../src/web/models/use-model-readiness.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";
import { providerWithoutWindow, windowRoutes } from "../../fixtures/web/context-window.ts";

const BARE = { providerProfileId: "p1", modelId: "m1" };

/** An entry as the pages build it: the notice while the window is missing, then a usable button. */
function Entry(props: { modelRef: ModelRefDto; onSaved?: () => void }) {
  const readiness = useModelReadiness(props.modelRef, "context_window");
  const missing = readiness.status === "missing_context_window";
  return (
    <form onSubmit={(event) => event.preventDefault()} data-testid="entry">
      {missing ? <ContextWindowNotice modelRef={props.modelRef} {...(props.onSaved === undefined ? {} : { onSaved: props.onSaved })} /> : null}
      <button type="submit" disabled={missing || readiness.status === "loading"}>
        开始
      </button>
    </form>
  );
}

function withMaxOutput(profile: ProviderProfileDto, maxOutputTokens: number): ProviderProfileDto {
  return { ...profile, models: profile.models.map((model) => ({ ...model, limits: { ...model.limits, userOverride: { maxOutputTokens } } })) };
}

const input = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>("上下文窗口");
const save = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>("button", { name: "保存" });

describe("ContextWindowNotice", () => {
  it("names the model, explains why, and links to the model settings", async () => {
    mockApi(windowRoutes([providerWithoutWindow("p1", "我的服务", ["m1"])]).routes);
    renderApp(<Entry modelRef={BARE} />);
    const notice = await screen.findByTestId("context-window-notice");
    expect(notice.textContent).toContain("「我的服务 · m1」还没有填写上下文窗口，总结、章节、高光与 AI 对话需要它。");
    expect(notice.getAttribute("role")).toBe("group");
    expect(screen.getByTestId("context-window-notice-settings").getAttribute("href")).toBe("/settings/models");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "开始" }).disabled).toBe(true);
    // Nothing to save until something is typed.
    expect(save().disabled).toBe(true);
  });

  it("refuses what is not a positive integer, without a request", async () => {
    const { routes, overrides } = windowRoutes([providerWithoutWindow("p1", "我的服务", ["m1"])]);
    mockApi(routes);
    renderApp(<Entry modelRef={BARE} />);
    await screen.findByTestId("context-window-notice");
    for (const value of ["0", "-5", "12.5", "abc"]) {
      fireEvent.change(input(), { target: { value } });
      fireEvent.click(save());
      expect((await screen.findByTestId("context-window-notice-error")).textContent).toBe("请填写正整数，例如 128000 或 128K");
      expect(input().getAttribute("aria-invalid")).toBe("true");
    }
    // Typing again clears the complaint.
    fireEvent.change(input(), { target: { value: "1" } });
    expect(screen.queryByTestId("context-window-notice-error")).toBeNull();
    expect(overrides).toEqual([]);
  });

  it("saves through the override, keeping the model's max output, and the entry becomes usable", async () => {
    const { routes, overrides } = windowRoutes([withMaxOutput(providerWithoutWindow("p1", "我的服务", ["m1"]), 8192)]);
    mockApi(routes);
    const onSaved = vi.fn();
    renderApp(<Entry modelRef={BARE} onSaved={onSaved} />);
    await screen.findByTestId("context-window-notice");
    fireEvent.change(input(), { target: { value: "128K" } });
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByTestId("context-window-notice")).toBeNull());
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.path).toBe("/api/providers/p1/models/m1/override");
    expect(overrides[0]?.body).toEqual({ limits: { contextWindowTokens: 128_000, maxOutputTokens: 8192 } });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "开始" }).disabled).toBe(false);
  });

  it("fills a common size, and Enter saves without submitting the surrounding form", async () => {
    const { routes, overrides } = windowRoutes([providerWithoutWindow("p1", "我的服务", ["m1"])]);
    mockApi(routes);
    renderApp(<Entry modelRef={BARE} />);
    await screen.findByTestId("context-window-notice");
    const chips = screen.getByRole("group", { name: "常用值" });
    expect(chips.textContent).toBe("32K64K128K200K256K1M");
    fireEvent.click(screen.getByRole("button", { name: "填入 200K（200,000 tokens）" }));
    expect(input().value).toBe("200K");
    // Default prevented: the form around it would otherwise take Enter as its own submit.
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
    await waitFor(() => expect(overrides).toHaveLength(1));
    expect(overrides[0]?.body).toEqual({ limits: { contextWindowTokens: 200_000, maxOutputTokens: null } });
  });

  it("shows a failed save in place and keeps the entry blocked", async () => {
    const { routes } = windowRoutes([providerWithoutWindow("p1", "我的服务", ["m1"])]);
    mockApi({
      ...routes,
      "PUT /api/providers/p1/models/m1/override": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict", retryDisposition: "never", userMessage: "该模型正被任务使用" } },
      },
    });
    renderApp(<Entry modelRef={BARE} />);
    await screen.findByTestId("context-window-notice");
    fireEvent.change(input(), { target: { value: "64000" } });
    fireEvent.click(save());
    expect((await screen.findByTestId("context-window-notice-error")).textContent).toBe("该模型正被任务使用");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "开始" }).disabled).toBe(true);
  });

  it("without the model in the list, only points to the settings", async () => {
    mockApi({ "GET /api/providers": { body: { items: [] } } });
    renderApp(<ContextWindowNotice modelRef={{ providerProfileId: "gone", modelId: "old" }} />);
    await waitFor(() => expect(screen.getByTestId("context-window-notice").textContent).toContain("「old」还没有填写上下文窗口"));
    expect(screen.queryByLabelText("上下文窗口")).toBeNull();
    expect(screen.getByTestId("context-window-notice-settings").getAttribute("href")).toBe("/settings/models");
  });
});

describe("ContextWindowNotice variants", () => {
  it("keeps the minimal one to the field and 「保存」, with the common sizes as input suggestions", async () => {
    mockApi(windowRoutes([providerWithoutWindow("p1", "我的服务", ["m1"])]).routes);
    renderApp(<ContextWindowNotice modelRef={BARE} variant="minimal" />);
    const notice = await screen.findByTestId("context-window-notice");
    await waitFor(() => expect(input()).toBeTruthy());
    expect(screen.queryByRole("group", { name: "常用值" })).toBeNull();
    expect(screen.queryByTestId("context-window-notice-settings")).toBeNull();
    expect(input().getAttribute("role")).toBe("combobox");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const list = await screen.findByRole("listbox", { name: "常用值" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["32K", "64K", "128K", "200K", "256K", "1M"]);
    expect(notice.querySelector("datalist")).toBeNull();
  });

  it("gives its links a colour that reads on the tinted ground in every theme", async () => {
    mockApi(windowRoutes([providerWithoutWindow("p1", "我的服务", ["m1"])]).routes);
    renderApp(<ContextWindowNotice modelRef={BARE} />);
    const link = await screen.findByTestId("context-window-notice-settings");
    expect(link.className).toContain("text-accent-ink");
    expect(link.className).toContain("dark:text-accent");
  });

  it("a deferring notice only points to a full one for the same model, whose field it focuses", async () => {
    mockApi(windowRoutes([providerWithoutWindow("p1", "我的服务", ["m1"])]).routes);
    function Both() {
      const [full, setFull] = useState(true);
      return (
        <>
          {full ? <ContextWindowNotice modelRef={BARE} testId="full" /> : null}
          <ContextWindowNotice modelRef={BARE} defer testId="deferred" />
          <button type="button" onClick={() => setFull(false)}>
            收起
          </button>
        </>
      );
    }
    renderApp(<Both />);
    await waitFor(() => expect(screen.getByTestId("deferred").dataset["variant"]).toBe("pointer"));
    expect(screen.getByTestId("deferred").textContent).toContain("「我的服务 · m1」还没有填写上下文窗口，在旁边的提示里填好即可使用。");
    expect(screen.getAllByLabelText("上下文窗口")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "去填写" }));
    expect(document.activeElement).toBe(screen.getByTestId("full-input"));
    // Without the full one it asks in full itself.
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    await waitFor(() => expect(screen.getByTestId("deferred").dataset["variant"]).toBe("full"));
    expect(screen.getByLabelText("上下文窗口")).toBeTruthy();
  });
});
