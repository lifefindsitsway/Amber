import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../../../../src/shared/errors.ts";
import { ApiError } from "../../../../src/web/api/client.ts";
import { ConfirmButton, TestConnectionError } from "../../../../src/web/pages/settings/settings-ui.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const PIPELINE_WORDING = "已按服务端要求等待并自动重试仍未成功；可稍后从这步重跑";

function failure(overrides: Partial<AppError>): ApiError {
  return new ApiError(429, {
    class: "llm_rate_limited",
    code: "llm_rate_limited",
    retryDisposition: "policy",
    userMessage: PIPELINE_WORDING,
    ...overrides,
  });
}

function show(error: unknown) {
  mockApi({});
  renderApp(<TestConnectionError error={error} />);
}

describe("TestConnectionError", () => {
  it("names the wait in whole seconds when the upstream gave a retry-after", () => {
    show(failure({ code: "llm_rate_limited.retry_after", details: { retryAfterMs: 58200 } }));
    expect(screen.getByRole("alert").textContent).toContain("模型服务请求频率受限，请约 59 秒后再测试，或换用其它模型");
    expect(screen.getByRole("alert").textContent).not.toContain("重跑");
  });

  it("asks to test later when no wait is known", () => {
    show(failure({}));
    expect(screen.getByRole("alert").textContent).toContain("模型服务请求频率受限，请稍后再测试，或换用其它模型");
    expect(screen.getByRole("alert").textContent).not.toContain("重跑");
  });

  it("treats a rate-limited transcription test the same way", () => {
    show(failure({ class: "asr_failed", code: "asr_failed.rate_limited", details: { retryAfterMs: 59000 } }));
    expect(screen.getByRole("alert").textContent).toContain("请约 59 秒后再测试");
    show(failure({ class: "asr_failed", code: "asr_failed.rate_limited" }));
    expect(screen.getAllByRole("alert")[1]?.textContent).toContain("请稍后再测试");
  });

  it("keeps the upstream detail toggle", () => {
    show(failure({ upstreamMessage: "429 Too Many Requests" }));
    fireEvent.click(screen.getByRole("button", { name: "上游原文" }));
    expect(screen.getByText("429 Too Many Requests")).toBeTruthy();
  });

  it("leaves every other error with its own message", () => {
    show(failure({ class: "llm_failed", code: "llm_failed.auth", retryDisposition: "never", userMessage: "Key 无效或已过期" }));
    expect(screen.getByRole("alert").textContent).toBe("Key 无效或已过期");
  });

  it("shows nothing for a non-API error", () => {
    show(new Error("boom"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ConfirmButton", () => {
  function open(props: { destructive?: boolean; onConfirm?: () => void }) {
    mockApi({});
    renderApp(<ConfirmButton label="移除记录" confirmLabel="移除" message="确定移除？" onConfirm={props.onConfirm ?? (() => {})} {...(props.destructive === undefined ? {} : { destructive: props.destructive })} />);
    const trigger = screen.getByRole("button", { name: "移除记录" });
    fireEvent.click(trigger);
    return { trigger, confirm: screen.getByRole("button", { name: "移除" }) };
  }

  it("keeps a destructive trigger neutral and saves the filled red for the dialog's final button", () => {
    const onConfirm = vi.fn();
    const { trigger, confirm } = open({ destructive: true, onConfirm });
    expect(trigger.className.split(" ")).toEqual(expect.arrayContaining(["border-line", "bg-surface"]));
    expect(trigger.className).not.toContain("danger");
    expect(confirm.className.split(" ")).toContain("bg-danger");
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms a non-destructive action with the primary button", () => {
    const { confirm } = open({});
    expect(confirm.className.split(" ")).toContain("bg-accent-glow");
    expect(confirm.className).not.toContain("danger");
  });
});
