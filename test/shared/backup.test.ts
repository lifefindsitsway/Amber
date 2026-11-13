import { describe, expect, it } from "vitest";
import {
  backupHeaderSchema,
  cacheArchivePath,
  filterUiPreferences,
  isBackupPreferenceKey,
  isCacheArchivePath,
  isOriginalArchivePath,
  originalArchivePath,
} from "../../src/shared/backup.ts";
import { BACKUP_UI_PREFERENCE_MAX_BYTES, BACKUP_UI_PREFERENCES_MAX_BYTES } from "../../src/shared/defaults.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../src/shared/subtitle-style.ts";

const CONTENT = "01J9Z8Y7X6W5V4T3S2R1Q0P9N8";

describe("archive paths", () => {
  it("names originals by asset id and a plain extension only", () => {
    expect(originalArchivePath("01ASSET", "第一讲 录像.MP4")).toBe("originals/01ASSET.mp4");
    expect(originalArchivePath("01ASSET", "no-extension")).toBe("originals/01ASSET");
    expect(originalArchivePath("01ASSET", "weird.ext-with/slash")).toBe("originals/01ASSET");
    expect(() => originalArchivePath("../x", "a.mp4")).toThrow();
    expect(isOriginalArchivePath("originals/01ASSET.mp4")).toBe(true);
    expect(isOriginalArchivePath("originals/../amber.db")).toBe(false);
  });

  it("keeps cache file names that pass the cache name check", () => {
    expect(cacheArchivePath("第一讲.mp4")).toBe("media/第一讲.mp4");
    expect(isCacheArchivePath("media/第一讲.mp4")).toBe(true);
    expect(isCacheArchivePath("media/../x.mp4")).toBe(false);
    expect(() => cacheArchivePath("CON.mp4")).toThrow();
  });
});

describe("filterUiPreferences", () => {
  it("accepts every whitelisted preference with a valid value, including a full subtitle appearance", () => {
    const appearance = JSON.stringify({ ...defaultSubtitleAppearance(), background: { ...defaultSubtitleAppearance().background, enabled: true } });
    expect(Buffer.byteLength(appearance)).toBeGreaterThan(256);
    const input = {
      "amber.subtitle.appearance.local": appearance,
      "amber.subtitle.placement.local": JSON.stringify(defaultSubtitlePlacement()),
      [`amber.subtitle.placement.local.${CONTENT}`]: JSON.stringify(defaultSubtitlePlacement()),
      [`amber.subtitle.track.local.${CONTENT}`]: JSON.stringify({ version: 1, mode: "bilingual" }),
      "amber.reader.typography.local": JSON.stringify({ version: 1, fontSize: 24, lineHeight: 1.8, showSpeakers: false }),
      "amber.player.volume": "0.35",
      "amber.player.muted": "1",
      "amber.player.autoplay": "0",
      "amber.player.endBehavior": "loop_one",
      "amber.notes.color.underline": "blue",
      "amber.notes.color.background": "pink",
    };
    const { accepted, dropped } = filterUiPreferences(input);
    expect(dropped).toEqual([]);
    expect(accepted).toEqual(input);
  });

  it("accepts both formats of the subtitle track and drops a damaged one", () => {
    const track = (userId: string) => `amber.subtitle.track.${userId}.${CONTENT}`;
    const input = {
      [track("v1")]: JSON.stringify({ version: 1, mode: "bilingual", revisionId: "r1", translationRevisionId: "t1" }),
      [track("v2")]: JSON.stringify({ version: 2, mode: "translation", revisionId: "r1", translation: { language: "en", lockedRevisionId: "t1" } }),
      [track("v2follow")]: JSON.stringify({ version: 2, mode: "off", translation: { language: "ja" } }),
      [track("mixed")]: JSON.stringify({ version: 2, mode: "bilingual", translationRevisionId: "t1" }),
      [track("v3")]: JSON.stringify({ version: 3, mode: "bilingual" }),
    };
    const { accepted, dropped } = filterUiPreferences(input);
    expect(Object.keys(accepted).sort()).toEqual([track("v1"), track("v2"), track("v2follow")].sort());
    expect(dropped.map((item) => [item.key, item.reason])).toEqual([
      [track("mixed"), "invalid_value"],
      [track("v3"), "invalid_value"],
    ]);
  });

  it("drops keys outside the whitelist, invalid values and values over the per-value cap, with a reason each", () => {
    const { accepted, dropped } = filterUiPreferences({
      "amber.sidebar.width": "300",
      "amber.player.volume": "2",
      "amber.player.endBehavior": "shuffle",
      "amber.subtitle.appearance.local": "{not json",
      [`amber.subtitle.track.local.${CONTENT}`]: "x".repeat(BACKUP_UI_PREFERENCE_MAX_BYTES + 1),
      "amber.notes.color.underline": "green",
    });
    expect(accepted).toEqual({ "amber.notes.color.underline": "green" });
    expect(dropped).toEqual([
      { key: "amber.player.endBehavior", reason: "invalid_value" },
      { key: "amber.player.volume", reason: "invalid_value" },
      { key: "amber.sidebar.width", reason: "not_allowed" },
      { key: "amber.subtitle.appearance.local", reason: "invalid_value" },
      { key: `amber.subtitle.track.local.${CONTENT}`, reason: "too_large" },
    ]);
  });

  it("keeps whole entries up to the total cap, in sorted key order, and drops the rest as total_too_large", () => {
    const value = JSON.stringify(defaultSubtitlePlacement());
    const input: Record<string, string> = {};
    const count = Math.ceil(BACKUP_UI_PREFERENCES_MAX_BYTES / value.length) + 10;
    for (let i = 0; i < count; i += 1) {
      input[`amber.subtitle.placement.u${String(i).padStart(6, "0")}`] = value;
    }
    const { accepted, dropped } = filterUiPreferences(input);
    const total = Object.entries(accepted).reduce((sum, [key, v]) => sum + Buffer.byteLength(key) + Buffer.byteLength(v), 0);
    expect(total).toBeLessThanOrEqual(BACKUP_UI_PREFERENCES_MAX_BYTES);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((entry) => entry.reason === "total_too_large")).toBe(true);
    expect(Object.keys(accepted).length + dropped.length).toBe(count);
    const lastAccepted = Object.keys(accepted).sort().at(-1) as string;
    expect(dropped.every((entry) => entry.key > lastAccepted)).toBe(true);
  });

  it("drops a reader typography with an invalid value or an unsafe user id, and leaves other keys alone", () => {
    const valid = JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true });
    const withMargin = JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true, sideMargin: 120 });
    const { accepted, dropped } = filterUiPreferences({
      "amber.reader.typography.ok": valid,
      "amber.reader.typography.margin": withMargin,
      "amber.reader.typography.badmargin": JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true, sideMargin: 4 }),
      "amber.reader.typography.fontsize": JSON.stringify({ version: 1, fontSize: 33, lineHeight: 1.7, showSpeakers: true }),
      "amber.reader.typography.lineheight": JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.75, showSpeakers: true }),
      "amber.reader.typography.extra": JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true, color: "red" }),
      "amber.reader.typography.broken": "{nope",
      "amber.reader.typography.": valid,
      "amber.reader.typography.a.b": valid,
      "amber.player.muted": "1",
    });
    expect(accepted).toEqual({ "amber.reader.typography.ok": valid, "amber.reader.typography.margin": withMargin, "amber.player.muted": "1" });
    expect(dropped).toEqual([
      { key: "amber.reader.typography.", reason: "not_allowed" },
      { key: "amber.reader.typography.a.b", reason: "not_allowed" },
      { key: "amber.reader.typography.badmargin", reason: "invalid_value" },
      { key: "amber.reader.typography.broken", reason: "invalid_value" },
      { key: "amber.reader.typography.extra", reason: "invalid_value" },
      { key: "amber.reader.typography.fontsize", reason: "invalid_value" },
      { key: "amber.reader.typography.lineheight", reason: "invalid_value" },
    ]);
  });

  it("carries a reader typography saved with or without a font, and drops one whose font or custom name is damaged", () => {
    const old = JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true });
    const withFont = JSON.stringify({ version: 1, fontSize: 18, lineHeight: 1.8, showSpeakers: true, font: "kai" });
    const withCustom = JSON.stringify({ version: 1, fontSize: 18, lineHeight: 1.8, showSpeakers: true, font: "custom", customFont: "Kaiti SC" });
    const { accepted, dropped } = filterUiPreferences({
      "amber.reader.typography.old": old,
      "amber.reader.typography.font": withFont,
      "amber.reader.typography.custom": withCustom,
      "amber.reader.typography.badfont": JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true, font: "comic" }),
      "amber.reader.typography.badname": JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: true, font: "custom", customFont: "x;}y" }),
    });
    expect(accepted).toEqual({ "amber.reader.typography.old": old, "amber.reader.typography.font": withFont, "amber.reader.typography.custom": withCustom });
    expect(dropped).toEqual([
      { key: "amber.reader.typography.badfont", reason: "invalid_value" },
      { key: "amber.reader.typography.badname", reason: "invalid_value" },
    ]);
  });

  it("recognises whitelisted keys only", () => {
    expect(isBackupPreferenceKey("amber.reader.typography.u1")).toBe(true);
    expect(isBackupPreferenceKey("amber.player.volume")).toBe(true);
    expect(isBackupPreferenceKey("amber.updates.autoCheck")).toBe(false);
    expect(isBackupPreferenceKey("amber.subtitle.track.local.not-a-content")).toBe(false);
  });
});

describe("backupHeaderSchema", () => {
  it("rejects a newer format version, another mode and unsafe archive paths", () => {
    const header = {
      formatVersion: 1,
      mode: "local",
      amberVersion: "0.1.0",
      schemaVersion: 18,
      createdAt: 1,
      encryption: "none",
      includes: { originals: true, cache: false },
      excludedOriginals: [],
      counts: { contents: 1, collections: 0, notes: 0, originals: 1, cache: 0 },
      sizes: { database: 1, originals: 1, cache: 0 },
      originals: [{ assetId: "01A", archivePath: "originals/01A.mp4", originalName: "a.mp4", sizeBytes: 1, fingerprint: null }],
      cache: [],
      uiPreferences: {},
    };
    expect(backupHeaderSchema.safeParse(header).success).toBe(true);
    expect(backupHeaderSchema.safeParse({ ...header, formatVersion: 2 }).success).toBe(false);
    expect(backupHeaderSchema.safeParse({ ...header, mode: "server" }).success).toBe(false);
    expect(
      backupHeaderSchema.safeParse({ ...header, originals: [{ ...header.originals[0], archivePath: "originals/../../x" }] }).success,
    ).toBe(false);
  });
});
