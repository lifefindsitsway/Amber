import { oneLine, type ExportCue } from "./cues.ts";
import { vttTime } from "./time-format.ts";

/** The WebVTT file header: the signature line and a blank line. */
export const VTT_HEADER = "WEBVTT\n\n";

/**
 * One WebVTT cue without id or settings, followed by a blank line. The text is escaped:
 * unescaped, a `<…>` in what was said would be read as a tag and dropped by players and by
 * a later import.
 */
export function vttCue(cue: ExportCue, speaker?: string): string {
  const voice = speaker === undefined ? "" : `<v ${vttVoiceName(speaker)}>`;
  return `${vttTime(cue.startMs)} --> ${vttTime(cue.endMs)}\n${voice}${vttText(cue.text)}\n\n`;
}

/** The characters WebVTT treats as markup, as character references; `&` first so none is escaped twice. */
function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cue text on one line (a blank line would end the cue) with its markup characters escaped; text without them is unchanged. */
export function vttText(text: string): string {
  return escapeMarkup(oneLine(text));
}

/** A voice annotation up to its closing `>`: escaped like cue text, and on one line. */
export function vttVoiceName(name: string): string {
  return escapeMarkup(oneLine(name));
}
