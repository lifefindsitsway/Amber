import { describe, expect, it } from "vitest";
import { fetchPlatformCover } from "../../../../src/server/adapters/platform/cover.ts";
import type { PlatformDownloadRequest, PlatformMediaDownload } from "../../../../src/server/adapters/platform/download.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { ScriptedHttp, signal } from "../../../fixtures/platform/scripted-io.ts";

const DOMAINS = ["hdslb.com", "biliimg.com"] as const;
const TRUSTED = ["api.bilibili.com", "hdslb.com", "biliimg.com"] as const;

/** A downloader stand-in that records what it was asked and "downloads" 42 bytes. */
function recordingDownload(): { download: PlatformMediaDownload; requests: PlatformDownloadRequest[] } {
  const requests: PlatformDownloadRequest[] = [];
  return {
    requests,
    download: async (_http, request) => {
      requests.push(request);
      return { sizeBytes: 42, mimeType: "image/jpeg" };
    },
  };
}

describe("fetchPlatformCover", () => {
  it("hands the downloader an image request on the platform's hosts, without a cookie, into the caller's job directory", async () => {
    const http = new ScriptedHttp();
    const { download, requests } = recordingDownload();
    const result = await fetchPlatformCover(http, download, {
      coverUrl: "https://i0.hdslb.com/bfs/archive/a.jpg",
      domains: DOMAINS,
      trustedHosts: TRUSTED,
      output: { path: "/data/tmp/figures/job/input.partial" },
      maxBytes: 1234,
      signal: signal(),
    });
    expect(result).toEqual({ sizeBytes: 42 });
    expect(requests).toEqual([
      {
        url: "https://i0.hdslb.com/bfs/archive/a.jpg",
        allowedHosts: DOMAINS,
        trustedHosts: TRUSTED,
        kind: "image",
        maxBytes: 1234,
        output: { path: "/data/tmp/figures/job/input.partial", scratchDir: "/data/tmp/figures/job" },
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(JSON.stringify(requests[0]?.headers ?? {}).toLowerCase()).not.toContain("cookie");
    // The downloader makes the requests; nothing went out here.
    expect(http.requests).toEqual([]);
  });

  it("refuses anything but https on the platform's image hosts before any request", async () => {
    const http = new ScriptedHttp();
    const { download, requests } = recordingDownload();
    for (const coverUrl of [
      "http://i0.hdslb.com/a.jpg",
      "https://evilhdslb.com/a.jpg",
      "https://hdslb.com.example.com/a.jpg",
      "https://user:pass@i0.hdslb.com/a.jpg",
      "https://i0.hdslb.com:8443/a.jpg",
      "https://127.0.0.1/a.jpg",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const error = await fetchPlatformCover(http, download, { coverUrl, domains: DOMAINS, trustedHosts: TRUSTED, output: { path: "/tmp/x" }, maxBytes: 1, signal: signal() }).catch((caught: unknown) => caught);
      expect([coverUrl, isAmberError(error) && error.appError.class]).toEqual([coverUrl, "source_unreachable"]);
      // The URL is not echoed back in the error.
      expect([coverUrl, isAmberError(error) && JSON.stringify(error.appError).includes(coverUrl)]).toEqual([coverUrl, false]);
    }
    expect(requests).toEqual([]);
    expect(http.requests).toEqual([]);
  });

  it("passes the downloader's failure on", async () => {
    const failing: PlatformMediaDownload = () => Promise.reject(new Error("refused"));
    await expect(
      fetchPlatformCover(new ScriptedHttp(), failing, { coverUrl: "https://i0.hdslb.com/a.jpg", domains: DOMAINS, trustedHosts: TRUSTED, output: { path: "/tmp/x" }, maxBytes: 1, signal: signal() }),
    ).rejects.toThrow("refused");
  });
});
