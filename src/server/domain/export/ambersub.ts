import { SUBTITLE_ASS_DATA_CHUNK, SUBTITLE_IMPORT_MAX_BYTES } from "../../../shared/defaults.ts";
import type { ContentSpeaker } from "../speaker.ts";
import {
  ASS_RESTORE_EFFECT,
  ASS_RESTORE_PROTOCOL,
  assDialogueDigest,
  SUBTITLE_PACKAGE_FORMAT,
  SUBTITLE_PACKAGE_VERSION,
  type SubtitlePackage,
  type SubtitlePackageSegment,
  type SubtitlePackageSpeaker,
  type SubtitlePackageTranslation,
} from "../subtitle-package.ts";
import type { TranscriptRevision, TranscriptSegment } from "../transcript.ts";

/** What a package is built from: one original revision, its Content's speakers and translations made from it. */
export interface SubtitlePackageSource {
  revision: Pick<TranscriptRevision, "language">;
  /** The revision's sentences; written in ordinal order whatever order they come in. */
  segments: readonly TranscriptSegment[];
  /** The Content's speakers; only those a sentence names are written. */
  speakers: ReadonlyArray<Pick<ContentSpeaker, "id" | "ordinal" | "name" | "colorIndex">>;
  /** Translations whose parent is `revision`, each with its sentences. */
  translations: ReadonlyArray<{ language: string; segments: readonly TranscriptSegment[] }>;
  /** Amber's version, recorded as the generator; never read for compatibility. */
  version: string;
}

const byOrdinal = (a: { ordinal: number }, b: { ordinal: number }): number => a.ordinal - b.ordinal;

/**
 * The package of one revision. Keys are short and positional — sentence `"1"`, `"2"`, … in
 * ordinal order, speaker `"s<ordinal>"` — so they leak no database id and the same revision
 * always yields the same package. Text is stored text, before any subtitle rendering.
 * Blank sentences are left out, with the translation lines of them; a package with no
 * sentence left is not importable, and callers check `original.segments` for that.
 */
export function buildSubtitlePackage(source: SubtitlePackageSource): SubtitlePackage {
  const ordered = [...source.segments].sort(byOrdinal);
  const known = new Map(source.speakers.map((speaker) => [speaker.id, speaker]));
  const referenced = new Set(
    ordered.flatMap((segment) => (segment.speakerId !== undefined && known.has(segment.speakerId) && segment.text.trim() !== "" ? [segment.speakerId] : [])),
  );
  const speakerKeys = new Map<string, string>();
  const speakers: SubtitlePackageSpeaker[] = [...referenced]
    .map((id) => known.get(id) as Pick<ContentSpeaker, "id" | "ordinal" | "name" | "colorIndex">)
    .sort(byOrdinal)
    .map((speaker) => {
      const key = `s${speaker.ordinal}`;
      speakerKeys.set(speaker.id, key);
      return { key, ordinal: speaker.ordinal, ...(speaker.name === undefined ? {} : { name: speaker.name }), colorIndex: speaker.colorIndex };
    });
  // Paragraph marks are all-or-nothing within a revision, so the first sentence tells.
  const paragraphMarks = ordered[0]?.paragraphStart !== undefined;
  const segmentKeys = new Map<string, string>();
  const segments: SubtitlePackageSegment[] = [];
  // A paragraph start on a skipped sentence moves to the next written one, and the first written one always starts a paragraph.
  let pendingStart = true;
  for (const segment of ordered) {
    // A package sentence must have text, or no reader takes the package; a blank sentence shows nothing, so it is left out.
    if (segment.text.trim() === "") {
      pendingStart ||= segment.paragraphStart === true;
      continue;
    }
    const key = String(segments.length + 1);
    segmentKeys.set(segment.id, key);
    segments.push({
      key,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      // A sentence only ever names a speaker of its Content; one that does not is written unassigned rather than as a dangling key.
      speaker: segment.speakerId === undefined ? null : (speakerKeys.get(segment.speakerId) ?? null),
      ...(paragraphMarks ? { paragraphStart: pendingStart || segment.paragraphStart === true } : {}),
    });
    pendingStart = false;
  }
  const translations: SubtitlePackageTranslation[] = [...source.translations]
    .sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0))
    .map((translation) => ({
      language: translation.language,
      segments: [...translation.segments].sort(byOrdinal).flatMap((line) => {
        const sourceKey = line.sourceSegmentIds[0] === undefined ? undefined : segmentKeys.get(line.sourceSegmentIds[0]);
        // A blank line is an untranslated sentence: written, it would make the whole package unreadable.
        return sourceKey === undefined || line.text.trim() === "" ? [] : [{ sourceSegmentKey: sourceKey, text: line.text }];
      }),
    }));
  return {
    format: SUBTITLE_PACKAGE_FORMAT,
    formatVersion: SUBTITLE_PACKAGE_VERSION,
    generator: { app: "Amber", version: source.version },
    original: { language: source.revision.language, paragraphMarks, speakers, segments },
    translations,
  };
}

/** A restore-data `Comment` event: zero-length at the start, on the `Default` style, marked by its Effect field. */
function restoreEvent(text: string): string {
  return `Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,${ASS_RESTORE_EFFECT},${text}`;
}

/**
 * A styled ASS download with its restore data appended to `[Events]` (the last section of
 * every ASS Amber writes): first `amber-data <protocol> <digest of the dialogue>`, then the
 * base64 of `serializedPackage` in `SUBTITLE_ASS_DATA_CHUNK`-character pieces. The file's own
 * line ending is kept. When the result would not import again — larger than
 * `SUBTITLE_IMPORT_MAX_BYTES` — the document is returned unchanged.
 */
export function withAssRestoreData(document: string, serializedPackage: string): string {
  const eol = document.includes("\r\n") ? "\r\n" : "\n";
  const dialogue = document.split("\n").filter((line) => line.startsWith("Dialogue:"));
  const encoded = Buffer.from(serializedPackage, "utf8").toString("base64");
  const events = [restoreEvent(`${ASS_RESTORE_EFFECT} ${ASS_RESTORE_PROTOCOL} ${assDialogueDigest(dialogue)}`)];
  for (let at = 0; at < encoded.length; at += SUBTITLE_ASS_DATA_CHUNK) {
    events.push(restoreEvent(encoded.slice(at, at + SUBTITLE_ASS_DATA_CHUNK)));
  }
  const base = document === "" || document.endsWith("\n") ? document : `${document}${eol}`;
  const result = `${base}${events.map((event) => `${event}${eol}`).join("")}`;
  return Buffer.byteLength(result, "utf8") > SUBTITLE_IMPORT_MAX_BYTES ? document : result;
}
