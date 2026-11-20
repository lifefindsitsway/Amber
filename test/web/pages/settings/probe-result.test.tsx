import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProbeResultDto } from "../../../../src/shared/dto/provider.ts";
import type { AppError } from "../../../../src/shared/errors.ts";
import { ApiError } from "../../../../src/web/api/client.ts";
import { ProbeResult } from "../../../../src/web/pages/settings/probe-result.tsx";

function failure(error: Partial<AppError> & Pick<AppError, "class" | "code">, status = 400): ApiError {
  return new ApiError(status, { retryDisposition: "never", userMessage: "", upstreamMessage: "Incorrect API key provided: sk-…", ...error });
}

const RESULT: ProbeResultDto = {
  modelId: "model-a",
  basic: { status: "connected", latencyMs: 812.4 },
  checks: [
    { flag: "stream", result: "supported" },
    { flag: "structuredOutput", result: "unsupported" },
    { flag: "tools", result: "inconclusive", reason: "truncated" },
  ],
  observed: { stream: "supported", structuredOutput: "unsupported" },
  observedAt: 2,
};

function badges(): Array<[string | null, string | null]> {
  return within(screen.getByTestId("probe-checks"))
    .getAllByRole("listitem")
    .map((item) => [item.getAttribute("data-result"), item.textContent]);
}

describe("ProbeResult", () => {
  it("says the connection worked with its latency and words each capability badge, with the reason when it could not tell", () => {
    render(<ProbeResult result={RESULT} regionHint={false} />);
    expect(screen.getByTestId("probe-connected").textContent).toBe("连接成功 · 延迟 812 ms");
    expect(badges()).toEqual([
      ["supported", "流式支持"],
      ["unsupported", "JSON不支持"],
      ["inconclusive", "工具未能确认· 输出上限内没生成完"],
    ]);
    const inconclusive = screen.getByTestId("probe-check-tools");
    expect(within(inconclusive).getByText("未能确认").className).toContain("text-muted");
  });

  it("gives each inconclusive reason its fixed wording, and an absent check as not confirmed", () => {
    render(
      <ProbeResult
        result={{
          ...RESULT,
          basic: { status: "incomplete", latencyMs: 5 },
          checks: [
            { flag: "stream", result: "inconclusive", reason: "upstream_rejected" },
            { flag: "structuredOutput", result: "inconclusive", reason: "rate_limited" },
          ],
        }}
        regionHint={false}
      />,
    );
    expect(screen.getByTestId("probe-incomplete").textContent).toBe("已连通，但在输出上限内未生成完");
    expect(badges()).toEqual([
      ["inconclusive", "流式未能确认· 服务返回了无法识别的错误"],
      ["inconclusive", "JSON未能确认· 被限流，稍后再试"],
      ["inconclusive", "工具未能确认"],
    ]);
  });

  it.each([
    ["llm_failed", "llm_failed.model_not_found", "模型不可用：这个服务下没有该模型 ID"],
    ["llm_failed", "llm_failed.invalid_request", "模型不可用：服务拒绝了测试请求，可能不支持该模型或协议"],
  ] as const)("calls a %s / %s failure the model being unavailable", (errorClass, code, text) => {
    render(<ProbeResult error={failure({ class: errorClass, code })} regionHint />);
    expect(screen.getByTestId("probe-unavailable").textContent).toBe(text);
    expect(screen.queryByTestId("probe-checks")).toBeNull();
    // A wrong region is only suggested for a rejected key.
    expect(screen.queryByTestId("probe-region-hint")).toBeNull();
  });

  it("adds that the key may belong to another region when a multi-region service rejects it, and keeps the upstream text out", () => {
    const { container, rerender } = render(<ProbeResult error={failure({ class: "llm_failed", code: "llm_failed.auth" }, 401)} regionHint />);
    expect(screen.getByTestId("probe-unavailable").textContent).toBe("模型不可用：API Key 无效，或没有该模型的使用权限");
    expect(screen.getByTestId("probe-region-hint").textContent).toBe("也可能是 Key 与所选地域不一致");
    expect(container.textContent).not.toContain("Incorrect API key");
    rerender(<ProbeResult error={failure({ class: "llm_failed", code: "llm_failed.auth" }, 401)} regionHint={false} />);
    expect(screen.queryByTestId("probe-region-hint")).toBeNull();
  });

  it.each([
    [{ class: "llm_rate_limited", code: "llm_rate_limited.retry_after", details: { retryAfterMs: 58_200 } }, "无法确认：被限流，请约 59 秒后再测试"],
    [{ class: "llm_rate_limited", code: "llm_rate_limited" }, "无法确认：被限流，请稍后再测试"],
    [{ class: "llm_failed", code: "llm_failed.quota" }, "无法确认：账户额度不足"],
    [{ class: "llm_failed", code: "llm_failed.unreachable" }, "无法确认：连不上服务，请检查 Base URL 与网络"],
    [{ class: "llm_outcome_unknown", code: "llm_outcome_unknown" }, "无法确认：没有收到完整的响应"],
    [{ class: "internal", code: "internal", userMessage: "服务内部错误" }, "无法确认：服务内部错误"],
  ] as const)("cannot confirm on %o", (error, text) => {
    render(<ProbeResult error={failure(error as Partial<AppError> & Pick<AppError, "class" | "code">, 429)} regionHint />);
    expect(screen.getByTestId("probe-unconfirmed").textContent).toBe(text);
  });

  it("shows the server's wording when the configuration changed during the test", () => {
    render(<ProbeResult error={failure({ class: "conflict", code: "conflict.probe_config_changed", userMessage: "测试期间配置已更改，请重新测试" }, 409)} regionHint={false} />);
    expect(screen.getByTestId("probe-conflict").textContent).toBe("测试期间配置已更改，请重新测试");
  });

  it("shows nothing before a test", () => {
    const { container } = render(<ProbeResult regionHint={false} />);
    expect(container.innerHTML).toBe("");
  });
});
