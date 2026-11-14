import { scanCueTags, scanTimedSubtitle, unescapeCueEntities, type ScannedCue } from "../subtitle-file.ts";
import type { DocumentCue } from "../subtitle-document.ts";
import { speakerKeyOf } from "./speaker-names.ts";
import { DroppedCues } from "./dropped.ts";

// The inside of a voice tag: `v Name` or `v.class.other Name`. Anchored and without nested
// repetition, so it is linear in the tag.
const VOICE = /^v(?:\.[^\s>]*)?[ \t]+([\s\S]*)$/u;

/**
 * A WebVTT cue's lines as text, and its voice: the one name its `<v>` tags give, character
 * references resolved and normalized. The voice is absent when none names a usable speaker,
 * and `null` when several different ones do. Tags are found in the same single pass that
 * removes them.
 */
function readCueLines(raw: readonly string[], voices: boolean): { lines: string[]; voice?: string | null } {
  const lines: string[] = [];
  const names = new Set<string>();
  for (const line of raw) {
    const { text, tags } = scanCueTags(line);
    const cleaned = unescapeCueEntities(text).trim();
    if (cleaned !== "") lines.push(cleaned);
    if (!voices) continue;
    for (const tag of tags) {
      const match = VOICE.exec(tag);
      const key = match === null ? undefined : speakerKeyOf(unescapeCueEntities(match[1] as string));
      if (key !== undefined) names.add(key);
    }
  }
  if (names.size === 0) return { lines };
  return { lines, voice: names.size === 1 ? ([...names][0] as string) : null };
}

/**
 * SRT or WebVTT read into document cues, in file order. Timing and cleaning are those of the
 * plain subtitle import, so the kept cues' lines join to exactly the text it gives; cues with
 * invalid timing or without text are dropped and counted. A WebVTT cue keeps the voice its
 * `<v>` tags name; an SRT cue never has one (a leading name is decided later).
 */
export function readTimedDocument(text: string): { format: "srt" | "vtt"; cues: DocumentCue[]; dropped: DroppedCues } {
  const { format, cues: scanned } = scanTimedSubtitle(text);
  const dropped = new DroppedCues();
  const cues: DocumentCue[] = [];
  for (const cue of scanned) {
    const { lines, voice } = readCueLines(cue.lines, format === "vtt");
    if (!(cue.startMs < cue.endMs) || lines.length === 0) {
      dropped.add(sampleOf(cue, lines));
      continue;
    }
    cues.push({ index: cues.length, startMs: cue.startMs, endMs: cue.endMs, lines, ...(voice === undefined ? {} : { voice }) });
  }
  return { format, cues, dropped };
}

/** What names a dropped cue in a preview: its text, or its timing line when it has none. */
function sampleOf(cue: ScannedCue, lines: readonly string[]): string {
  return lines.length > 0 ? lines.join(" ") : cue.timing;
}
