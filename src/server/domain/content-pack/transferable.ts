import { createHash } from "node:crypto";
import type { ContentSpeaker } from "../speaker.ts";
import type { TranscriptRevision, TranscriptSegment } from "../transcript.ts";
import { canonicalJson } from "../canonical-json.ts";
import type { PackSpeaker, PackRevision, RevisionDocument } from "./document.ts";

/**
 * What of a transcript revision travels in a content pack and must arrive unchanged: its
 * language, joining rule and, per sentence, timing, text, word timing, paragraph mark and the
 * speaker's transfer identity. Kind, parent, sentence sources and generation are deliberately
 * left out: a corrected revision carried without its parent arrives as a standalone imported
 * revision, and carrying it back must still be recognised as the very same text (otherwise a
 * round trip A → B → A would report a conflict with itself).
 */
export interface TransferableRevision {
  language: string;
  looseJoin: boolean;
  segments: TransferableSegment[];
}

export interface TransferableSegment {
  startMs: number;
  endMs: number;
  text: string;
  words?: Array<{ text: string; startMs: number; endMs: number }>;
  /** `<content identity>\u0000<speaker id>`; absent = unassigned. */
  speaker?: string;
  paragraphStart?: boolean;
}

/** A speaker's transfer identity as one comparable string. */
export function speakerIdentityKey(identity: { contentId: string; speakerId: string }): string {
  return `${identity.contentId}\u0000${identity.speakerId}`;
}

/** The transfer identity of a local speaker of a Content whose own transfer identity is `contentIdentity`. */
export function localSpeakerIdentity(speaker: Pick<ContentSpeaker, "id" | "origin">, contentIdentity: string): string {
  return speakerIdentityKey(speaker.origin ?? { contentId: contentIdentity, speakerId: speaker.id });
}

/** The transfer identity of a speaker as a pack carries it. */
export function packSpeakerIdentity(speaker: Pick<PackSpeaker, "originContentKey" | "originSpeakerId">): string {
  return speakerIdentityKey({ contentId: speaker.originContentKey, speakerId: speaker.originSpeakerId });
}

/** A local revision's transferable content; `speakers` are its Content's speakers. */
export function transferableOfLocal(
  revision: Pick<TranscriptRevision, "language" | "looseJoin">,
  segments: readonly Pick<TranscriptSegment, "startMs" | "endMs" | "text" | "words" | "speakerId" | "paragraphStart">[],
  speakers: readonly Pick<ContentSpeaker, "id" | "origin">[],
  contentIdentity: string,
): TransferableRevision {
  const byId = new Map(speakers.map((speaker) => [speaker.id, localSpeakerIdentity(speaker, contentIdentity)]));
  return {
    language: revision.language,
    looseJoin: revision.looseJoin === true,
    segments: segments.map((segment) => {
      const speaker = segment.speakerId === undefined ? undefined : (byId.get(segment.speakerId) ?? speakerIdentityKey({ contentId: contentIdentity, speakerId: segment.speakerId }));
      return sentence(segment.startMs, segment.endMs, segment.text, segment.words, speaker, segment.paragraphStart);
    }),
  };
}

/** A carried revision's transferable content; `speakers` are its Content document's speakers. */
export function transferableOfPack(revision: Pick<PackRevision, "language" | "looseJoin">, document: RevisionDocument, speakers: readonly PackSpeaker[]): TransferableRevision {
  return {
    language: revision.language,
    looseJoin: revision.looseJoin === true,
    segments: document.segments.map((segment) => {
      const owner = segment.speaker === undefined ? undefined : speakers[segment.speaker];
      if (segment.speaker !== undefined && owner === undefined) {
        throw new RangeError(`speaker index ${segment.speaker} is outside the document's speakers`);
      }
      return sentence(segment.startMs, segment.endMs, segment.text, segment.words, owner === undefined ? undefined : packSpeakerIdentity(owner), segment.paragraphStart);
    }),
  };
}

function sentence(
  startMs: number,
  endMs: number,
  text: string,
  words: ReadonlyArray<{ text: string; startMs: number; endMs: number }> | undefined,
  speaker: string | undefined,
  paragraphStart: boolean | undefined,
): TransferableSegment {
  return {
    startMs,
    endMs,
    text,
    ...(words === undefined ? {} : { words: words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })) }),
    ...(speaker === undefined ? {} : { speaker }),
    ...(paragraphStart === undefined ? {} : { paragraphStart }),
  };
}

/** Hex SHA-256 of the canonical form; equal digests mean the same transferable content. */
export function transferableDigest(revision: TransferableRevision): string {
  return createHash("sha256").update(canonicalJson(revision)).digest("hex");
}

/** Same language, joining rule and sentences: the carried revision is already here. */
export function sameTransferableContent(a: TransferableRevision, b: TransferableRevision): boolean {
  return transferableDigest(a) === transferableDigest(b);
}

/**
 * Same text and timing regardless of speakers and paragraphs: used only to tell the user that
 * a carried revision of another identity reads exactly like a local one; never merges them.
 */
export function textAndTimingDigest(revision: TransferableRevision): string {
  return createHash("sha256")
    .update(canonicalJson({ language: revision.language, segments: revision.segments.map((segment) => [segment.startMs, segment.endMs, segment.text]) }))
    .digest("hex");
}
