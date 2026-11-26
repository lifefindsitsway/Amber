import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { downloadProgressLabel, UpdateFailureNotice } from "../../../src/web/desktop/update-failure-notice.tsx";
import type { UpdateFailure } from "../../../src/web/desktop/update-failure.ts";
import i18n from "i18next";

const MB = 1024 * 1024;

function show(error: UpdateFailure, version: string | undefined = "0.9.0") {
  render(<UpdateFailureNotice error={error} version={version} />);
  const notice = screen.getByTestId("update-failure");
  const details = screen.getByTestId("update-failure-details") as HTMLDetailsElement;
  // The title, then the body, each as its own text.
  const title = notice.querySelector(".font-medium")?.textContent;
  const body = notice.querySelector("p")?.textContent;
  return { notice, details, title, body };
}

describe("UpdateFailureNotice", () => {
  it.each<[string, UpdateFailure, string, string]>([
    [
      "interrupted",
      { step: "download", kind: "interrupted", attempts: 5, detail: "error decoding response body", progress: { downloaded: 120 * MB, total: 190 * MB } },
      "下载没能完成",
      "网络多次中断，已自动重连 5 次，下载到 63%（120.0 MB / 190.0 MB）。点「重试」会接着已下载的部分继续；如果网络一直不稳，可以换个网络，或在浏览器中下载安装包，运行后即可完成升级，数据不受影响。",
    ],
    ["unreachable", { step: "download", kind: "unreachable", attempts: 0, detail: "dns error" }, "连不上 GitHub", "Amber 的更新来自 GitHub，请确认网络可用后重试。"],
    ["server", { step: "download", kind: "server", status: 503, attempts: 1, detail: "503" }, "GitHub 暂时没有返回安装包", "服务器返回 503，请稍后重试，或在浏览器中下载安装包。"],
    ["integrity", { step: "download", kind: "integrity", attempts: 0, detail: "signature" }, "安装包校验未通过", "下载的文件与发布签名不一致，已丢弃，没有安装任何内容。请重试。"],
    ["disk", { step: "install", kind: "disk", detail: "os error 112" }, "磁盘空间不足", "请在系统盘腾出空间后重试。"],
    ["other check", { step: "check", kind: "other", detail: "x" }, "检查更新失败", "请重试；如果仍然失败，可以在浏览器中下载安装包。"],
    ["other download", { step: "download", kind: "other", detail: "x" }, "下载失败", "请重试；如果仍然失败，可以在浏览器中下载安装包。"],
    ["other install", { step: "install", kind: "other", detail: "x" }, "安装失败", "请重试；如果仍然失败，可以在浏览器中下载安装包。"],
    ["sidecar", { step: "install", kind: "other", detail: "internal.unexpected", code: "internal.unexpected", userMessage: "后端出了点问题" }, "安装失败", "后端出了点问题"],
  ])("explains %s in plain words", (_name, error, title, body) => {
    const shown = show(error);
    expect(shown.title).toBe(title);
    expect(shown.body).toBe(body);
    expect(shown.notice.getAttribute("role")).toBe("alert");
  });

  it("folds the technical details away: the step, the reconnects and the raw message, without any query", () => {
    const { details } = show({ step: "download", kind: "interrupted", attempts: 5, detail: "error decoding response body: https://objects.example/a.exe", progress: { downloaded: 1 } });
    expect(details.open).toBe(false);
    expect(within(details).getByText("技术信息").tagName).toBe("SUMMARY");
    const items = Array.from(details.querySelectorAll("li"), (item) => item.textContent);
    expect(items).toEqual(["步骤：下载", "自动重连 5 次", "error decoding response body: https://objects.example/a.exe"]);
    expect(details.textContent).not.toContain("?");
  });

  it("leaves the reconnect count out when there were none", () => {
    const { details } = show({ step: "check", kind: "unreachable", detail: "error sending request" });
    expect(Array.from(details.querySelectorAll("li"), (item) => item.textContent)).toEqual(["步骤：检查更新", "error sending request"]);
  });

  it("links the release of the version, or the release list when the version is unknown", () => {
    show({ step: "download", kind: "other", detail: "x" }, "0.9.0");
    const link = screen.getByTestId("update-browser-download");
    expect(link.textContent).toBe("在浏览器中下载");
    expect(link.getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber/releases/tag/v0.9.0");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    document.body.innerHTML = "";
    render(<UpdateFailureNotice error={{ step: "check", kind: "other", detail: "x" }} version={undefined} />);
    expect(screen.getByTestId("update-browser-download").getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber/releases");
  });
});

describe("downloadProgressLabel", () => {
  it("shows the percentage with both sizes once the total is known, the bytes alone before", () => {
    const t = i18n.t.bind(i18n);
    expect(downloadProgressLabel(t, { downloaded: 120 * MB, total: 190 * MB })).toBe("63%（120.0 MB / 190.0 MB）");
    expect(downloadProgressLabel(t, { downloaded: 120 * MB })).toBe("120.0 MB");
    expect(downloadProgressLabel(t, { downloaded: 200, total: 100 })).toBe("100%（100 B / 100 B）");
  });
});
