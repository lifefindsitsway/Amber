import { oneLine, type ExportCue } from "./cues.ts";
import { vttTime } from "./time-format.ts";

/** The WebVTT file header: the signature line and a blank line. */
export const VTT_HEADER = "WEBVTT\n\n";

/** One WebVTT cue without id or settings, followed by a blank line. */
export function vttCue(cue: ExportCue, speaker?: string): string {
  const voice = speaker === undefined ? "" : `<v ${vttVoiceName(speaker)}>`;
  return `${vttTime(cue.startMs)} --> ${vttTime(cue.endMs)}\n${voice}${oneLine(cue.text)}\n\n`;
}

/**
 * A voice annotation up to its closing `>`: the characters WebVTT treats as markup become
 * character references, and the name stays on one line (a blank line would end the cue).
 */
export function vttVoiceName(name: string): string {
  return oneLine(name).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
