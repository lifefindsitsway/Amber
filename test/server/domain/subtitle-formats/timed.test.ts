import { describe, expect, it } from "vitest";
import { cleanCueLine, parseTimedSubtitle, scanCueTags } from "../../../../src/server/domain/subtitle-file.ts";
import { readTimedDocument } from "../../../../src/server/domain/subtitle-formats/timed.ts";

describe("SRT and WebVTT cues", () => {
  it("never gives an SRT cue a voice, even with a <v> tag in it", () => {
    const { format, cues } = readTimedDocument("1\n00:00:00,000 --> 00:00:01,000\n<v Ann>hello\n");
    expect(format).toBe("srt");
    expect(cues).toEqual([{ index: 0, startMs: 0, endMs: 1000, lines: ["hello"] }]);
  });

  it("numbers kept cues in file order, skipping dropped ones", () => {
    const { cues, dropped } = readTimedDocument("WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nback\n\n00:00:03.000 --> 00:00:04.000\n<b></b>\n\n00:00:05.000 --> 00:00:06.000\nkept\n");
    expect(cues.map((cue) => [cue.index, cue.lines])).toEqual([[0, ["kept"]]]);
    expect(dropped.toJSON()).toEqual({ count: 2, samples: ["back", "00:00:03.000 --> 00:00:04.000"] });
  });
});

describe("cue markup", () => {
  it("removes tags exactly as the tag pattern did", () => {
    const regex = (line: string): string => line.replace(/<[^>]*>/g, "");
    const alphabet = ["<", ">", "a", "v", " ", "&amp;"];
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 2000; round += 1) {
      const line = Array.from({ length: Math.floor(random() * 12) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      expect(scanCueTags(line).text).toBe(regex(line));
      expect(cleanCueLine(line)).toBe(regex(line).replace(/&amp;/g, "&").trim());
    }
  });

  it("reads a long line of unclosed tags in linear time, in the reader and the plain parser", () => {
    const hostile = "<v a".repeat(50_000);
    const vtt = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${hostile}\n`;
    const started = performance.now();
    const { cues } = readTimedDocument(vtt);
    const parsed = parseTimedSubtitle(vtt);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(cues[0]?.lines).toEqual([hostile]);
    expect(cues[0]?.voice).toBeUndefined();
    expect(parsed.cues[0]?.text).toBe(hostile);
  });

  it("takes the voice from a closed tag after unclosed text", () => {
    const { cues } = readTimedDocument("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Ann>a < b\n");
    expect(cues[0]).toMatchObject({ lines: ["a < b"], voice: "Ann" });
  });
});
