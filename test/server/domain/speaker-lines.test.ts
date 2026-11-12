import { describe, expect, it } from "vitest";
import { SPEAKER_LINES_FRAGMENT, SPEAKER_RULES_FRAGMENT } from "../../../src/server/domain/prompts.ts";
import { attributionDigest, type SpeakerContextSnapshot } from "../../../src/server/domain/speaker-context.ts";
import { speakerLinesFragmentOf, speakerSectionForRead } from "../../../src/server/domain/speaker-lines.ts";

const segments = [
  { id: "s1", speakerId: "x" },
  { id: "s2", speakerId: "x" },
  { id: "s3" },
  { id: "s4", speakerId: "y" },
  { id: "s5", speakerId: "x" },
];

const snapshot: SpeakerContextSnapshot = {
  version: 1,
  rules: SPEAKER_LINES_FRAGMENT.ref,
  attributionDigest: attributionDigest(segments),
  speakers: [
    { id: "x", ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" },
    { id: "y", ordinal: 2, label: "发言人 2" },
  ],
};

const lines = (names: string[]) => names.map((name, index) => ({ name, ...(segments[index]?.speakerId === undefined ? {} : { speakerId: segments[index]?.speakerId as string }) }));

describe("speakerSectionForRead", () => {
  it("is absent without a snapshot", () => {
    expect(speakerSectionForRead(undefined, segments)).toBeUndefined();
  });

  it("appends the rules, the roster and the call's runs after the terminology; unassigned lines are not listed", () => {
    const section = speakerSectionForRead(snapshot, segments);
    const expected = [SPEAKER_LINES_FRAGMENT.text, "蒋炎岩", "发言人 2", "s1–s2 蒋炎岩", "s4 发言人 2", "s5 蒋炎岩"].join("\n");
    expect(section?.termsValue("【术语表】\nRAG", lines(["s1", "s2", "s3", "s4", "s5"]))).toBe(`【术语表】\nRAG\n\n${expected}`);
    // With no terminology the section is the whole value.
    expect(section?.termsValue("", lines(["s1", "s2", "s3", "s4", "s5"]))).toBe(expected);
    // Translation batches name their lines by number.
    expect(section?.termsValue("", lines(["1", "2", "3", "4", "5"])).split("\n").slice(-3)).toEqual(["1–2 蒋炎岩", "4 发言人 2", "5 蒋炎岩"]);
    expect(section?.rules).toBe(SPEAKER_LINES_FRAGMENT);
    expect(section?.snapshot).toBe(snapshot);
  });

  it("refuses to read with a snapshot that does not describe the revision, names unknown rules or lacks a label", () => {
    const fail = (input: SpeakerContextSnapshot, read = segments) => {
      try {
        speakerSectionForRead(input, read);
      } catch (error) {
        return (error as { appError?: { class?: string } }).appError?.class;
      }
      return "no error";
    };
    expect(fail(snapshot, [...segments.slice(0, 4), { id: "s5", speakerId: "y" }])).toBe("internal");
    expect(fail({ ...snapshot, rules: SPEAKER_RULES_FRAGMENT.ref })).toBe("internal");
    expect(fail({ ...snapshot, speakers: snapshot.speakers.slice(0, 1) })).toBe("internal");
  });
});

describe("speakerLinesFragmentOf", () => {
  it("knows only the speaker section fragment this build sends", () => {
    expect(speakerLinesFragmentOf(SPEAKER_LINES_FRAGMENT.ref)).toBe(SPEAKER_LINES_FRAGMENT);
    expect(speakerLinesFragmentOf({ ...SPEAKER_LINES_FRAGMENT.ref, version: SPEAKER_LINES_FRAGMENT.ref.version + 1 })).toBeUndefined();
    expect(speakerLinesFragmentOf(SPEAKER_RULES_FRAGMENT.ref)).toBeUndefined();
  });
});
