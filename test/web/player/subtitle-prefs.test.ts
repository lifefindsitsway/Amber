import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import {
  readAppearance,
  readPlacement,
  readTrack,
  relockTranslation,
  resetSubtitlePrefsMemory,
  subtitlePrefKeys,
  upgradeTrackPref,
  useSubtitlePrefs,
  writeDefaultPlacement,
  writePlacement,
  writeTrack,
} from "../../../src/web/player/subtitle-prefs.ts";

const moved = { version: 1 as const, xBp: 1500, yBp: 2000, anchor: "top" as const };

describe("subtitle preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSubtitlePrefsMemory();
  });

  it("starts with subtitles off and the system defaults", () => {
    expect(readTrack("u1", "c1")).toEqual({ version: 2, mode: "off" });
    expect(readAppearance("u1")).toEqual(defaultSubtitleAppearance());
    expect(readPlacement("u1", "c1")).toEqual(defaultSubtitlePlacement());
  });

  it("falls back to defaults for damaged or outdated entries", () => {
    localStorage.setItem(subtitlePrefKeys.appearance("u1"), "{not json");
    localStorage.setItem(subtitlePrefKeys.placement("u1", "c1"), JSON.stringify({ ...moved, version: 0 }));
    localStorage.setItem(subtitlePrefKeys.track("u1", "c1"), JSON.stringify({ version: 1, mode: "karaoke" }));
    expect(readAppearance("u1")).toEqual(defaultSubtitleAppearance());
    expect(readPlacement("u1", "c1")).toEqual(defaultSubtitlePlacement());
    expect(readTrack("u1", "c1").mode).toBe("off");
    // A second-format entry with a first-format field, or a translation without its language, is damaged too.
    localStorage.setItem(subtitlePrefKeys.track("u1", "c1"), JSON.stringify({ version: 2, mode: "bilingual", translationRevisionId: "t1" }));
    expect(readTrack("u1", "c1")).toEqual({ version: 2, mode: "off" });
    localStorage.setItem(subtitlePrefKeys.track("u1", "c1"), JSON.stringify({ version: 2, mode: "bilingual", translation: { lockedRevisionId: "t1" } }));
    expect(readTrack("u1", "c1")).toEqual({ version: 2, mode: "off" });
  });

  it("reads a first-format translation as following its language once the revisions are known", () => {
    const revisions = [
      { id: "r1", kind: "platform", language: "zh-CN" },
      { id: "t1", kind: "translated", language: "en" },
    ];
    localStorage.setItem(subtitlePrefKeys.track("u1", "c1"), JSON.stringify({ version: 1, mode: "bilingual", revisionId: "r1", translationRevisionId: "t1" }));
    const stored = readTrack("u1", "c1");
    expect(stored.version).toBe(1);
    expect(upgradeTrackPref(stored, revisions)).toEqual({ version: 2, mode: "bilingual", revisionId: "r1", translation: { language: "en" } });
    // A remembered translation that is gone (or not a translation) leaves the default pick.
    expect(upgradeTrackPref({ version: 1, mode: "translation", translationRevisionId: "gone" }, revisions)).toEqual({ version: 2, mode: "translation" });
    expect(upgradeTrackPref({ version: 1, mode: "translation", translationRevisionId: "r1" }, revisions)).toEqual({ version: 2, mode: "translation" });
    const current = { version: 2, mode: "original", translation: { language: "ja", lockedRevisionId: "t9" } } as const;
    expect(upgradeTrackPref(current, revisions)).toBe(current);
  });

  it("moves a lock on the edited version to the committed one, and leaves following or other locks alone", () => {
    writeTrack("u1", "c1", { version: 2, mode: "bilingual", revisionId: "r1", translation: { language: "en", lockedRevisionId: "t1" } });
    relockTranslation("u1", "c1", "t1", "t2");
    expect(readTrack("u1", "c1")).toEqual({ version: 2, mode: "bilingual", revisionId: "r1", translation: { language: "en", lockedRevisionId: "t2" } });

    writeTrack("u1", "c2", { version: 2, mode: "translation", translation: { language: "en" } });
    relockTranslation("u1", "c2", "t1", "t2");
    expect(readTrack("u1", "c2")).toEqual({ version: 2, mode: "translation", translation: { language: "en" } });

    writeTrack("u1", "c3", { version: 2, mode: "translation", translation: { language: "en", lockedRevisionId: "t0" } });
    relockTranslation("u1", "c3", "t1", "t2");
    expect(readTrack("u1", "c3")).toEqual({ version: 2, mode: "translation", translation: { language: "en", lockedRevisionId: "t0" } });

    // A first-format preference already follows its language; it is not rewritten.
    const legacy = JSON.stringify({ version: 1, mode: "translation", translationRevisionId: "t1" });
    localStorage.setItem(subtitlePrefKeys.track("u1", "c4"), legacy);
    relockTranslation("u1", "c4", "t1", "t2");
    expect(localStorage.getItem(subtitlePrefKeys.track("u1", "c4"))).toBe(legacy);
  });

  it("resolves placement as content override, then user default, then system default", () => {
    writeDefaultPlacement("u1", { ...moved, anchor: "center", yBp: 5000 });
    expect(readPlacement("u1", "c1")).toMatchObject({ anchor: "center", yBp: 5000 });
    writePlacement("u1", "c1", moved);
    expect(readPlacement("u1", "c1")).toEqual(moved);
    expect(readPlacement("u1", "c2")).toMatchObject({ anchor: "center" });
  });

  it("keeps users apart in one browser", () => {
    writePlacement("u1", "c1", moved);
    expect(readPlacement("u2", "c1")).toEqual(defaultSubtitlePlacement());
  });

  it("gives every hook the same values after a write and resets with the documented scope", () => {
    const player = renderHook(() => useSubtitlePrefs("u1", "c1"));
    const dialog = renderHook(() => useSubtitlePrefs("u1", "c1"));
    const before = player.result.current.appearance;
    act(() => player.result.current.setPlacement(moved));
    expect(dialog.result.current.placement).toEqual(moved);
    expect(dialog.result.current.placementOverridden).toBe(true);
    expect(player.result.current.appearance).toBe(player.result.current.appearance);

    act(() => player.result.current.setDefaultPlacement());
    act(() => player.result.current.resetPlacement());
    expect(dialog.result.current.placementOverridden).toBe(false);
    expect(dialog.result.current.placement).toEqual(moved);

    act(() => player.result.current.setAppearance({ ...before, original: { fontSize: 60, color: "#FF0000" } }));
    expect(dialog.result.current.appearance.original).toEqual({ fontSize: 60, color: "#FF0000" });
    act(() => player.result.current.resetAppearance());
    expect(dialog.result.current.appearance).toEqual(defaultSubtitleAppearance());
    expect(dialog.result.current.placement).toEqual(moved);
  });
});
