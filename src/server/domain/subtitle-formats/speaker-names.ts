import { SPEAKER_NAME_MAX_GRAPHEMES } from "../../../shared/defaults.ts";
import { exportFile } from "../../../shared/i18n/zh-CN/export-file.ts";
import { graphemesOf, normalizeSpeakerName } from "../../../shared/speakers.ts";
import { fillText } from "../export/markdown.ts";

/**
 * Speaker names as subtitle files carry them: a leading `Name:` on an SRT line, and the
 * default label an export writes for a speaker nobody named.
 */

/** A name as a speaker key: normalized, or `undefined` when nothing usable is left (empty or too long). */
export function speakerKeyOf(raw: string): string | undefined {
  const name = normalizeSpeakerName(raw);
  return name === undefined || name === "too_long" ? undefined : name;
}

// Sentence-ending punctuation never appears in a name: "结束了。然后：…" is text. Commas may:
// exports write names such as "Smith-Johnson, PhD：" as they are.
const SENTENCE_PUNCTUATION = /[。！？.!?…；;]/u;
// Digits and clock separators only ("12：30", "3.5: …"): a time or a number, not a name.
const NUMERIC = /^[\d\s:：.．]+$/u;

/** The leading speaker name of a line and the text after it. */
export interface LinePrefix {
  /** The name as a speaker key. */
  key: string;
  /** The line without the prefix, trimmed; may be empty. */
  rest: string;
}

/**
 * The speaker name a line starts with: `名字：` (full-width colon, spaces after it optional)
 * or `Name: ` (half-width colon followed by white space), as exports write them. The first
 * colon of the line decides; the name trimmed must be 1…`SPEAKER_NAME_MAX_GRAPHEMES`
 * grapheme clusters without sentence-ending punctuation, not only digits or a time, and not the
 * scheme of a URL (`https://`). Anything else is ordinary text.
 */
export function linePrefix(line: string): LinePrefix | undefined {
  const match = /[:：]/u.exec(line);
  if (match === null) return undefined;
  const colon = match[0];
  const after = line.slice(match.index + 1);
  if (colon === ":" && !/^\s/u.test(after)) return undefined;
  if (after.startsWith("//")) return undefined;
  const name = line.slice(0, match.index).trim();
  if (name === "" || graphemesOf(name).length > SPEAKER_NAME_MAX_GRAPHEMES) return undefined;
  if (SENTENCE_PUNCTUATION.test(name) || NUMERIC.test(name)) return undefined;
  const key = speakerKeyOf(name);
  return key === undefined ? undefined : { key, rest: after.trim() };
}

const ORDINAL_SLOT = "{{ordinal}}";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The default label exports write for an unnamed speaker, with its number captured. Built from
// the same resource the exporter fills, so the two can never drift apart.
const DEFAULT_LABEL = (() => {
  const template = exportFile.speakerDefault;
  const at = template.indexOf(ORDINAL_SLOT);
  return new RegExp(`^${escapeRegExp(template.slice(0, at))}([1-9]\\d{0,8})${escapeRegExp(template.slice(at + ORDINAL_SLOT.length))}$`, "u");
})();

/** N of a name that is exactly the default label of an unnamed speaker ("发言人 N"), else `undefined`. */
export function defaultLabelOrdinal(name: string): number | undefined {
  const match = DEFAULT_LABEL.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/** The default label of the unnamed speaker with this ordinal ("发言人 N"). */
export function defaultSpeakerLabel(ordinal: number): string {
  return fillText(exportFile.speakerDefault, { ordinal: String(ordinal) });
}
