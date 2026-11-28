import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BilibiliAdapter } from "../../src/server/adapters/platform/bilibili/index.ts";
import { DouyinAdapter } from "../../src/server/adapters/platform/douyin/index.ts";
import { XiaohongshuAdapter } from "../../src/server/adapters/platform/xiaohongshu/index.ts";
import { YoutubeAdapter } from "../../src/server/adapters/platform/youtube/index.ts";
import type { PlatformSourceAdapter } from "../../src/server/ports/platform-source.ts";
import { PLATFORMS } from "../../src/shared/enums.ts";
import { LOGIN_PLATFORMS, PLATFORM_CAPABILITIES } from "../../src/shared/platforms.ts";

// Constructing an adapter touches none of its dependencies, so placeholders are enough here.
const deps = { http: {} as never, ytDlp: {} as never };
const ADAPTERS: readonly PlatformSourceAdapter[] = [
  new BilibiliAdapter(deps),
  new YoutubeAdapter(deps),
  new XiaohongshuAdapter(deps),
  new DouyinAdapter(deps),
];

describe("PLATFORM_CAPABILITIES", () => {
  it("has one adapter per platform", () => {
    expect(ADAPTERS.map((adapter) => adapter.kind).sort()).toEqual([...PLATFORMS].sort());
  });

  it.each(ADAPTERS.map((adapter) => [adapter.kind, adapter] as const))("%s implements exactly what its row says", (kind, adapter) => {
    const row = PLATFORM_CAPABILITIES[kind];
    expect(adapter.checkCredential !== undefined).toBe(row.loginSupported);
    expect(adapter.cookieDomains !== undefined && adapter.cookieDomains.length > 0).toBe(row.loginSupported);
    expect(adapter.precheck !== undefined).toBe(row.importCheck);
  });

  it.each(ADAPTERS.map((adapter) => [adapter.kind, adapter] as const))("%s declares its own proxy hosts as bare, lowercase host names", (_kind, adapter) => {
    expect(adapter.trustedHosts.length).toBeGreaterThan(0);
    expect(new Set(adapter.trustedHosts).size).toBe(adapter.trustedHosts.length);
    for (const host of adapter.trustedHosts) {
      expect(host).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
    }
  });

  it("keeps trustedHosts out of every API DTO", () => {
    const dir = new URL("../../src/shared/dto/", import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(readFileSync(new URL(name, dir), "utf8"), name).not.toMatch(/trustedHosts/i);
    }
  });

  it("lists login platforms in enumeration order", () => {
    expect(LOGIN_PLATFORMS).toEqual(["bilibili", "youtube", "xiaohongshu"]);
  });

  it("gives an online player only to platforms with an embeddable one", () => {
    expect(PLATFORMS.filter((platform) => PLATFORM_CAPABILITIES[platform].onlinePlayer)).toEqual(["bilibili", "youtube"]);
    expect(PLATFORMS.filter((platform) => PLATFORM_CAPABILITIES[platform].linkMayExpire)).toEqual(["xiaohongshu"]);
  });
});
