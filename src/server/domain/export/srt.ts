import { oneLine, type ExportCue } from "./cues.ts";
import { srtTime } from "./time-format.ts";

/**
 * One numbered SRT cue with its trailing blank line. A bilingual cue has two text
 * lines, the original first; `index` counts from 1. `speakerPrefix` (`名字：`) goes in
 * front of the original line only: the translation is never labelled.
 */
export function srtCue(index: number, cue: ExportCue, speakerPrefix = ""): string {
  const lines = [`${speakerPrefix}${oneLine(cue.text)}`];
  if (cue.translation !== undefined) {
    lines.push(oneLine(cue.translation));
  }
  return `${index}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${lines.join("\n")}\n\n`;
}
