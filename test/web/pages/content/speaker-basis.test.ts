import { describe, expect, it } from "vitest";
import type { SpeakerContextDto } from "../../../../src/shared/dto/speaker-context.ts";
import { initI18n } from "../../../../src/web/i18n.ts";
import { speakerBasisNotice, speakersNotRead } from "../../../../src/web/pages/content/speaker-basis.ts";

const t = initI18n().t;
const speakers = [{ id: "sp1", label: "陈明" }];
const reviewed = { speakerMode: true, confirmed: true };

function notice(context: SpeakerContextDto | undefined, options: { stale?: boolean; primary?: { speakerMode: boolean; confirmed: boolean } } = {}) {
  return speakerBasisNotice(t, { stale: options.stale ?? false, speakerContext: context, primary: options.primary });
}

describe("speakerBasisNotice", () => {
  it("words each of the five states that call for a notice, and says nothing when consistent", () => {
    expect(notice({ state: "attribution_changed", speakers, changedSentences: 3 })).toEqual({
      state: "attribution_changed",
      text: "生成后有 3 句改了发言人，其中的人物观点可能不再准确",
    });
    expect(notice({ state: "evidence_removed", speakers, removedCitations: 2 })).toEqual({ state: "evidence_removed", text: "引用的 2 句原话已被删除，相关结论失去依据" });
    expect(notice({ state: "unknown", speakers })).toEqual({ state: "unknown", text: "无法确认发言人依据是否仍然一致" });
    expect(notice({ state: "names_changed", speakers, renamed: [{ id: "sp1", was: "陈明", now: "陈敏" }] })).toEqual({ state: "names_changed", text: "生成时为陈明，现为陈敏" });
    expect(notice({ state: "unconfirmed", speakers })).toEqual({ state: "unconfirmed", text: "当前字幕稿的发言人未核对" });
    expect(notice({ state: "consistent", speakers })).toBeUndefined();
  });

  it("lists every rename, and falls back to a plain wording without counts or names", () => {
    const renamed = [
      { id: "sp1", was: "陈明", now: "陈敏" },
      { id: "sp2", was: "发言人 2", now: "李华" },
    ];
    expect(notice({ state: "names_changed", speakers, renamed })?.text).toBe("生成时为陈明，现为陈敏；生成时为发言人 2，现为李华");
    expect(notice({ state: "names_changed", speakers })?.text).toBe("生成后有发言人改了名字");
    expect(notice({ state: "attribution_changed", speakers })?.text).toBe("生成后有句子改了发言人，其中的人物观点可能不再准确");
    expect(notice({ state: "evidence_removed", speakers })?.text).toBe("引用的原话已被删除，相关结论失去依据");
  });

  it("shows nothing about speakers on a stale result, whatever its state", () => {
    expect(notice({ state: "attribution_changed", speakers, changedSentences: 3 }, { stale: true })).toBeUndefined();
    expect(notice(undefined, { stale: true, primary: reviewed })).toBeUndefined();
  });

  it("suggests regenerating with speakers only for a result made without them while the primary is reviewed and read by speakers", () => {
    expect(notice(undefined, { primary: reviewed })).toEqual({ state: "can_include", text: "重新生成可带上发言人" });
    expect(notice(undefined, { primary: { speakerMode: true, confirmed: false } })).toBeUndefined();
    expect(notice(undefined, { primary: { speakerMode: false, confirmed: true } })).toBeUndefined();
    expect(notice(undefined)).toBeUndefined();
    // A result made with speakers reports its own state instead.
    expect(notice({ state: "consistent", speakers }, { primary: reviewed })).toBeUndefined();
  });
});

describe("speakersNotRead", () => {
  it("holds only for text read by speakers that are not reviewed", () => {
    expect(speakersNotRead({ speakerMode: true, confirmed: false })).toBe(true);
    expect(speakersNotRead({ speakerMode: true, confirmed: true })).toBe(false);
    expect(speakersNotRead({ speakerMode: false, confirmed: false })).toBe(false);
    expect(speakersNotRead(undefined)).toBe(false);
  });
});
