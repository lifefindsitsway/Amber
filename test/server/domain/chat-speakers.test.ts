import { describe, expect, it } from "vitest";
import {
  allTurnSections,
  carriedSummary,
  clipNote,
  hasSearchTerms,
  historyNotice,
  historyNoticeFragment,
  interleavedGroups,
  mentionedSpeakers,
  mergedSpeakerBases,
  perSpeakerHits,
  sampleSection,
  speakerTurns,
  turnsShown,
} from "../../../src/server/domain/chat-speakers.ts";
import type { ChatSpeakerBasis } from "../../../src/server/domain/chat.ts";
import { SPEAKER_CAUTION_FRAGMENT, SPEAKER_RULES_FRAGMENT, SPEAKER_UNVERIFIED_FRAGMENT } from "../../../src/server/domain/prompts.ts";
import { speakerContextDigest, speakerLabels, type SpeakerContextSnapshot } from "../../../src/server/domain/speaker-context.ts";
import { CHAT_RETRIEVAL_HITS_MAX, CHAT_SPEAKER_SAMPLE_SENTENCES, CHAT_SPEAKER_SAMPLE_TURNS } from "../../../src/shared/defaults.ts";

const labeled = (...speakers: Array<{ name?: string; confirmed?: boolean }>) =>
  speakerLabels(
    speakers.map((speaker, index) => ({
      id: `sp${index + 1}`,
      ordinal: index + 1,
      ...(speaker.name === undefined ? {} : { name: speaker.name }),
      ...(speaker.confirmed === false || speaker.name === undefined ? {} : { nameConfirmedAt: 1 }),
    })),
  );

describe("people named in a question", () => {
  it("finds a confirmed name, NFKC and case-insensitive, and takes it out of the residual", () => {
    const speakers = labeled({ name: "Alice Zhang" }, { name: "蒋炎岩" });
    const found = mentionedSpeakers("ＡＬＩＣＥ zhang 怎么看测试？", speakers);
    expect(found.ids).toEqual(["sp1"]);
    expect(found.residual.trim()).toBe("怎么看测试？");
    expect(mentionedSpeakers("蒋炎岩怎么看操作系统", speakers).ids).toEqual(["sp2"]);
  });

  it("finds a two-character name but never a one-character one", () => {
    const speakers = labeled({ name: "张三" }, { name: "王" });
    expect(mentionedSpeakers("张三说了什么", speakers).ids).toEqual(["sp1"]);
    expect(mentionedSpeakers("王说了什么", speakers).ids).toEqual([]);
  });

  it("finds 「发言人 N」 with or without the space, and not inside a longer number", () => {
    const speakers = labeled({}, {});
    expect(mentionedSpeakers("发言人 2 的观点", speakers).ids).toEqual(["sp2"]);
    expect(mentionedSpeakers("发言人1和发言人 2", speakers).ids).toEqual(["sp1", "sp2"]);
    expect(mentionedSpeakers("发言人 12 的观点", speakers).ids).toEqual([]);
  });

  it("takes the longest name at each place", () => {
    const speakers = labeled({ name: "张三" }, { name: "张三丰" });
    expect(mentionedSpeakers("张三丰的太极", speakers).ids).toEqual(["sp2"]);
    expect(mentionedSpeakers("张三和张三丰", speakers).ids).toEqual(["sp1", "sp2"]);
  });

  it("maps a name two speakers share to both of them, by the bare name or by either label", () => {
    const speakers = labeled({ name: "李雷" }, { name: "李雷" }, { name: "韩梅梅" });
    expect(speakers.map((speaker) => speaker.label)).toEqual(["李雷（发言人 1）", "李雷（发言人 2）", "韩梅梅"]);
    expect(mentionedSpeakers("李雷说了什么", speakers).ids).toEqual(["sp1", "sp2"]);
    expect(mentionedSpeakers("李雷（发言人 2）说了什么", speakers).ids).toEqual(["sp2"]);
  });

  it("does not look for an unconfirmed name: such a speaker is only 「发言人 N」", () => {
    const speakers = labeled({ name: "张三", confirmed: false });
    expect(mentionedSpeakers("张三说了什么", speakers).ids).toEqual([]);
    expect(mentionedSpeakers("发言人 1 说了什么", speakers).ids).toEqual(["sp1"]);
  });

  it("tells whether search words remain once the names are out", () => {
    expect(hasSearchTerms("  怎么看")).toBe(true);
    expect(hasSearchTerms(" 说")).toBe(false);
    expect(hasSearchTerms("")).toBe(false);
  });

  it("shares the hit quota evenly among the people named", () => {
    expect(perSpeakerHits(1)).toBe(CHAT_RETRIEVAL_HITS_MAX);
    expect(perSpeakerHits(2)).toBe(Math.floor(CHAT_RETRIEVAL_HITS_MAX / 2));
    expect(perSpeakerHits(CHAT_RETRIEVAL_HITS_MAX * 2)).toBe(1);
  });
});

describe("turns and speaker clips", () => {
  const who = ["a", "a", "b", undefined, "b", "a", "b", "b"];
  const segments = who.map((speakerId, index) => ({ ...(speakerId === undefined ? {} : { speakerId }), startMs: index * 1000, endMs: index * 1000 + 900 }));

  it("cuts the sentences into turns, unassigned sentences belonging to none", () => {
    expect(speakerTurns(segments)).toEqual([
      { speakerId: "a", first: 0, last: 1 },
      { speakerId: "b", first: 2, last: 2 },
      { speakerId: "b", first: 4, last: 4 },
      { speakerId: "a", first: 5, last: 5 },
      { speakerId: "b", first: 6, last: 7 },
    ]);
  });

  it("takes every turn of a person with the sentence before it", () => {
    const [section] = allTurnSections(speakerTurns(segments), [{ id: "b", ordinal: 2, label: "乙" }]);
    expect(section).toEqual({ speakerId: "b", label: "乙", turns: 3, complete: true, groups: [[1, 2], [3, 4], [5, 6, 7]] });
  });

  it("samples the longest turn in each of the equal parts of the time line, at most the sample's sentences each", () => {
    // Speaker x speaks in every part: a one-sentence turn, then a long turn, alternating with y.
    const long = CHAT_SPEAKER_SAMPLE_SENTENCES + 3;
    const ids: string[] = [];
    for (let part = 0; part < CHAT_SPEAKER_SAMPLE_TURNS; part += 1) {
      ids.push("x", "y", ...Array.from({ length: long }, () => "x"), "y");
    }
    const timeline = ids.map((speakerId, index) => ({ speakerId, startMs: index * 1000, endMs: index * 1000 + 900 }));
    const section = sampleSection(speakerTurns(timeline), { id: "x", ordinal: 1, label: "甲" }, timeline);
    expect(section.complete).toBe(false);
    expect(section.turns).toBe(CHAT_SPEAKER_SAMPLE_TURNS * 2);
    expect(section.groups).toHaveLength(CHAT_SPEAKER_SAMPLE_TURNS);
    for (const group of section.groups) {
      expect(group).toHaveLength(CHAT_SPEAKER_SAMPLE_SENTENCES);
      expect(timeline[group[0] as number]?.speakerId).toBe("x");
      expect(timeline[(group[0] as number) - 1]?.speakerId).toBe("y");
    }
  });

  it("lets several people take turns at the room, first groups first", () => {
    const order = interleavedGroups([
      { speakerId: "a", label: "甲", turns: 2, complete: false, groups: [[1], [2]] },
      { speakerId: "b", label: "乙", turns: 1, complete: false, groups: [[5]] },
    ]);
    expect(order).toEqual([
      { section: 0, group: [1] },
      { section: 1, group: [5] },
      { section: 0, group: [2] },
    ]);
  });

  it("counts the turns the shown sentences touch, and writes the coverage line", () => {
    const turns = speakerTurns(segments);
    expect(turnsShown(turns, "b", new Set([2, 7]))).toBe(2);
    expect(clipNote("蒋炎岩", 96, "all")).toBe("【发言人片段】蒋炎岩 共 96 轮发言，以下为全部");
    expect(clipNote("蒋炎岩", 96, 6)).toBe("【发言人片段】蒋炎岩 共 96 轮发言，以下选取 6 轮，不是全部");
  });
});

describe("carried-in summary and history", () => {
  it("carries the summary by its speaker state", () => {
    expect(carriedSummary("正文", undefined)).toEqual({ kind: "carried", text: "正文" });
    expect(carriedSummary("正文", { state: "consistent" })).toEqual({ kind: "carried", text: "正文" });
    for (const state of ["attribution_changed", "evidence_removed", "unknown"] as const) {
      expect(carriedSummary("正文", { state })).toEqual({ kind: "omitted" });
    }
    expect(carriedSummary("正文", { state: "names_changed", renamed: [{ was: "甲", now: "乙" }, { was: "丙", now: "丁" }] })).toEqual({
      kind: "carried",
      text: "【改名】生成时为甲，现为乙\n【改名】生成时为丙，现为丁\n正文",
    });
    expect(carriedSummary("正文", { state: "unconfirmed" })).toEqual({ kind: "carried", text: `${SPEAKER_CAUTION_FRAGMENT.text}\n正文` });
  });

  it("gives one notice for the older text an answer carries: the caution over anything changed or unconfirmed, else unverified, else none", () => {
    expect(historyNotice([])).toBeUndefined();
    expect(historyNotice([undefined, "consistent", undefined])).toBeUndefined();
    for (const state of ["attribution_changed", "evidence_removed", "names_changed", "unconfirmed"] as const) {
      expect(historyNotice(["consistent", state]), state).toBe("caution");
      // Mixed with an answer that cannot be checked: the caution alone.
      expect(historyNotice(["unknown", state, "unknown"]), state).toBe("caution");
    }
    expect(historyNotice(["consistent", "unknown", undefined])).toBe("unverified");
    expect(historyNoticeFragment("caution")).toBe(SPEAKER_CAUTION_FRAGMENT);
    expect(historyNoticeFragment("unverified")).toBe(SPEAKER_UNVERIFIED_FRAGMENT);
  });

  it("merges the absorbed answers' bases into the previous compaction's, one per revision and speaker snapshot", () => {
    const snapshot = (label: string): SpeakerContextSnapshot => ({
      version: 1,
      rules: SPEAKER_RULES_FRAGMENT.ref,
      attributionDigest: "sha256:a",
      speakers: [{ id: "sp1", ordinal: 1, name: label, label }],
    });
    const basis = (revision: string, label: string, cited: string[]): ChatSpeakerBasis => ({ transcriptRevisionId: revision, speakerContext: snapshot(label), citedSegmentIds: cited });
    expect(mergedSpeakerBases(undefined, [])).toEqual([]);
    const previous = [basis("r1", "甲", ["s1", "s2"])];
    const merged = mergedSpeakerBases(previous, [basis("r1", "甲", ["s2", "s3"]), basis("r1", "乙", ["s4"]), basis("r2", "甲", ["s5", "s5"])]);
    expect(merged).toEqual([basis("r1", "甲", ["s1", "s2", "s3"]), basis("r1", "乙", ["s4"]), basis("r2", "甲", ["s5"])]);
    expect(merged.map((entry) => speakerContextDigest(entry.speakerContext))).toEqual([snapshot("甲"), snapshot("乙"), snapshot("甲")].map(speakerContextDigest));
    // The previous compaction's record is not changed in place.
    expect(previous).toEqual([basis("r1", "甲", ["s1", "s2"])]);
  });
});
