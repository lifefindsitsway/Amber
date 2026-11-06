import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AppError } from "../../../../src/shared/errors.ts";
import { ApiError } from "../../../../src/web/api/client.ts";
import { TestConnectionError } from "../../../../src/web/pages/settings/settings-ui.tsx";
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
