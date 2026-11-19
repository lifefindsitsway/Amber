import { describe, expect, it } from "vitest";
import type { PackSpeaker, RevisionDocument } from "../../../../src/server/domain/content-pack/document.ts";
import {
  sameTransferableContent,
  textAndTimingDigest,
  transferableDigest,
  transferableOfLocal,
  transferableOfPack,
} from "../../../../src/server/domain/content-pack/transferable.ts";

const local = [
  { startMs: 0, endMs: 1000, text: "你好。", speakerId: "0", paragraphStart: true, words: [{ text: "你好", startMs: 0, endMs: 900 }] },
  { startMs: 1000, endMs: 2000, text: "再见。", speakerId: "1", paragraphStart: false },
];
const speakers = [{ id: "0" }, { id: "1", origin: { contentId: "A-content", speakerId: "7" } }];

const packSpeakers: PackSpeaker[] = [
  { originContentKey: "A-content", originSpeakerId: "0", ordinal: 1, colorIndex: 0 },
  { originContentKey: "A-content", originSpeakerId: "7", ordinal: 2, colorIndex: 1 },
];
const packDocument: RevisionDocument = {
  key: "r1",
  segments: [
    { startMs: 0, endMs: 1000, text: "你好。", speaker: 0, paragraphStart: true, words: [{ text: "你好", startMs: 0, endMs: 900 }] },
    { startMs: 1000, endMs: 2000, text: "再见。", speaker: 1, paragraphStart: false },
  ],
};

describe("transferable content", () => {
  it("matches a carried revision with the local one whatever kind, parent and generation they have", () => {
    const here = transferableOfLocal({ language: "zh" }, local, speakers, "A-content");
    const carried = transferableOfPack({ language: "zh" }, packDocument, packSpeakers);
    expect(sameTransferableContent(here, carried)).toBe(true);
  });

  it("tells speakers apart by their transfer identity, never by a bare id", () => {
    const here = transferableOfLocal({ language: "zh" }, local, speakers, "B-content");
    const carried = transferableOfPack({ language: "zh" }, packDocument, packSpeakers);
    expect(sameTransferableContent(here, carried)).toBe(false);
  });

  it("differs on text, timing, words, paragraph marks, joining rule and language", () => {
    const base = transferableOfLocal({ language: "zh" }, local, speakers, "A-content");
    const variants = [
      transferableOfLocal({ language: "zh" }, [{ ...local[0]!, text: "您好。" }, local[1]!], speakers, "A-content"),
      transferableOfLocal({ language: "zh" }, [{ ...local[0]!, endMs: 999 }, local[1]!], speakers, "A-content"),
      transferableOfLocal({ language: "zh" }, [{ ...local[0]!, words: [{ text: "你好", startMs: 0, endMs: 800 }] }, local[1]!], speakers, "A-content"),
      transferableOfLocal({ language: "zh" }, [local[0]!, { ...local[1]!, paragraphStart: true }], speakers, "A-content"),
      transferableOfLocal({ language: "zh", looseJoin: true }, local, speakers, "A-content"),
      transferableOfLocal({ language: "zh-TW" }, local, speakers, "A-content"),
    ];
    for (const variant of variants) expect(transferableDigest(variant)).not.toBe(transferableDigest(base));
  });

  it("tells same text and timing apart from same content", () => {
    const a = transferableOfLocal({ language: "zh" }, local, speakers, "A-content");
    const b = transferableOfLocal({ language: "zh" }, local.map(({ speakerId: _ignored, ...rest }) => rest), [], "A-content");
    expect(sameTransferableContent(a, b)).toBe(false);
    expect(textAndTimingDigest(a)).toBe(textAndTimingDigest(b));
  });

  it("refuses a sentence naming a speaker the document does not have", () => {
    expect(() => transferableOfPack({ language: "zh" }, { key: "r", segments: [{ startMs: 0, endMs: 1, text: "x", speaker: 5 }] }, packSpeakers)).toThrow(RangeError);
  });
});
