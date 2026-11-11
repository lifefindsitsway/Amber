import { describe, expect, it } from "vitest";
import { isChinese, oneLineName, SpeakerLabeler, speakerLabels, speakerPrefix } from "../../../../src/server/domain/export/speaker-labels.ts";

describe("speakerLabels", () => {
  it("names a speaker by its own name or by its ordinal", () => {
    const labels = speakerLabels([
      { id: "a", ordinal: 1, name: "张三" },
      { id: "b", ordinal: 2 },
      { id: "c", ordinal: 3, name: "   " },
    ]);
    expect([...labels]).toEqual([
      ["a", "张三"],
      ["b", "发言人 2"],
      ["c", "发言人 3"],
    ]);
  });

  it("strips control and bidirectional characters defensively, falling back to the default when nothing is left", () => {
    const labels = speakerLabels([
      { id: "a", ordinal: 1, name: "ab‮cd‏e\u0007f" },
      { id: "b", ordinal: 2, name: "‮⁦" },
      { id: "c", ordinal: 3, name: "x".repeat(500) },
    ]);
    expect(labels.get("a")).toBe("ab cd e f");
    expect(labels.get("b")).toBe("发言人 2");
    expect(labels.get("c")).toBe("发言人 3");
    expect(speakerLabels([{ id: "d", ordinal: 4, name: "a\nb" }]).get("d")).toBe("a b");
  });
});

describe("speakerPrefix", () => {
  it("uses a full-width colon for Chinese text and `Name: ` otherwise", () => {
    expect(speakerPrefix("张三", true)).toBe("张三：");
    expect(speakerPrefix("Tom", false)).toBe("Tom: ");
    expect(speakerPrefix("$& $1", false)).toBe("$& $1: ");
    expect(speakerPrefix("{{name}}", true)).toBe("{{name}}：");
    expect(oneLineName("a\r\nb")).toBe("a b");
  });

  it("takes Chinese from the primary language subtag", () => {
    expect(["zh", "zh-CN", "zh-Hant-TW", "ZH_cn", "yue", "yue-HK", "cmn"].map(isChinese)).toEqual([true, true, true, true, true, true, true]);
    expect(["en", "ja", "", "zhx"].map(isChinese)).toEqual([false, false, false, false]);
  });
});

describe("SpeakerLabeler", () => {
  const run = (mode: "turn" | "every", speakers: (string | undefined)[]) => {
    const labeler = new SpeakerLabeler(mode);
    return speakers.map((speaker) => labeler.next(speaker));
  };

  it("labels the first of each run in turn mode and every one in every mode", () => {
    const input = ["a", "a", "b", "b", "a"];
    expect(run("turn", input)).toEqual([true, false, true, false, true]);
    expect(run("every", input)).toEqual([true, true, true, true, true]);
  });

  it("never labels an unassigned item, which ends the run", () => {
    const input = ["a", undefined, undefined, "a", "a"];
    expect(run("turn", input)).toEqual([true, false, false, true, false]);
    expect(run("every", input)).toEqual([true, false, false, true, true]);
  });

  it("forgets the run on restart", () => {
    const labeler = new SpeakerLabeler("turn");
    expect([labeler.next("a"), labeler.next("a")]).toEqual([true, false]);
    labeler.restart();
    expect(labeler.next("a")).toBe(true);
  });
});
