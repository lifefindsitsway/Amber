import { describe, expect, it } from "vitest";
import type { AppError } from "../../../src/shared/errors.ts";
import { ApiError } from "../../../src/web/api/client.ts";
import { checkFailure, downloadFailure, installFailure, redactDetail } from "../../../src/web/desktop/update-failure.ts";

describe("redactDetail", () => {
  it("drops query strings, fragments and credentials from URLs and keeps the rest of the message", () => {
    expect(redactDetail("error sending request for url (https://github.com/lifefindsitsway/Amber/releases/latest/download/latest.json?x=1)")).toBe(
      "error sending request for url (https://github.com/lifefindsitsway/Amber/releases/latest/download/latest.json)",
    );
    expect(redactDetail("GET https://objects.example/a.exe?X-Amz-Signature=abc&X-Amz-Credential=def#part failed: 403")).toBe("GET https://objects.example/a.exe failed: 403");
    expect(redactDetail("proxy http://user:secret@10.0.0.2:7890 refused")).toBe("proxy http://10.0.0.2:7890 refused");
    expect(redactDetail("plain text? with a question mark")).toBe("plain text? with a question mark");
  });
});

describe("checkFailure", () => {
  it("calls the feed unreachable when no request got through or no manifest came back", () => {
    expect(checkFailure("error sending request for url (https://github.com/lifefindsitsway/Amber/releases/latest/download/latest.json?x=1)")).toEqual({
      step: "check",
      kind: "unreachable",
      detail: "error sending request for url (https://github.com/lifefindsitsway/Amber/releases/latest/download/latest.json)",
    });
    expect(checkFailure(new Error("Could not fetch a valid release JSON from the remote"))).toMatchObject({ step: "check", kind: "unreachable" });
  });

  it("calls anything else other, with the message as the detail", () => {
    expect(checkFailure("the platform `windows-x86_64` was not found on the response `platforms` object")).toEqual({
      step: "check",
      kind: "other",
      detail: "the platform `windows-x86_64` was not found on the response `platforms` object",
    });
    expect(checkFailure({ unexpected: true })).toEqual({ step: "check", kind: "other", detail: '{"unexpected":true}' });
  });
});

describe("installFailure", () => {
  it("recognises a full disk by the Windows error code or the English wording", () => {
    expect(installFailure("failed to write the installer: The operation completed successfully. (os error 112)")).toMatchObject({ step: "install", kind: "disk" });
    expect(installFailure("There is NOT ENOUGH SPACE on the disk.")).toMatchObject({ kind: "disk" });
    expect(installFailure("os error 1123")).toMatchObject({ kind: "other" });
    expect(installFailure(new Error("the installer exited with code 2"))).toEqual({ step: "install", kind: "other", detail: "the installer exited with code 2" });
  });

  it("keeps the sidecar's code and explanation", () => {
    const error: AppError = { class: "internal", code: "internal.unexpected", retryDisposition: "safe", userMessage: "后端出了点问题" };
    expect(installFailure(new ApiError(500, error))).toEqual({ step: "install", kind: "other", detail: "internal.unexpected", code: "internal.unexpected", userMessage: "后端出了点问题" });
    expect(installFailure(new ApiError(500, { ...error, userMessage: "" }))).toEqual({ step: "install", kind: "other", detail: "internal.unexpected", code: "internal.unexpected" });
  });
});

describe("downloadFailure", () => {
  it("takes the shell's kind, status and attempts, with the progress it reached", () => {
    expect(downloadFailure({ kind: "server", status: 502, attempts: 2, detail: "https://github.com/a?b=c returned 502" }, { downloaded: 5, total: 10 })).toEqual({
      step: "download",
      kind: "server",
      status: 502,
      attempts: 2,
      detail: "https://github.com/a returned 502",
      progress: { downloaded: 5, total: 10 },
    });
    expect(downloadFailure({ kind: "interrupted", attempts: 5, detail: "error decoding response body" }, { downloaded: 5 })).toEqual({
      step: "download",
      kind: "interrupted",
      attempts: 5,
      detail: "error decoding response body",
      progress: { downloaded: 5 },
    });
  });

  it("has nothing specific to say about a busy shell or an unexpected rejection", () => {
    expect(downloadFailure({ kind: "busy", attempts: 0, detail: "a download is already running" })).toEqual({ step: "download", kind: "other", attempts: 0, detail: "a download is already running" });
    expect(downloadFailure("command update_download not found")).toEqual({ step: "download", kind: "other", detail: "command update_download not found" });
    expect(downloadFailure({ kind: "mystery", detail: "x" })).toMatchObject({ kind: "other" });
  });
});
