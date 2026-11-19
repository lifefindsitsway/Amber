import type { ContentSpeaker } from "../speaker.ts";

/**
 * Transfer identity: what names "the same object" on two devices. A record a content pack
 * created keeps the id it had where it came from in `originId`; any other record is known by
 * its own id. Carrying a record on again writes this value, so A → B → A finds A's original.
 */
export function originOf(record: { id: string; originId?: string | undefined }): string {
  return record.originId ?? record.id;
}

/**
 * A speaker's transfer identity: the pair (Content identity, speaker id), never the bare id,
 * since libraries written before speakers had identities reuse the same ids across Contents.
 */
export function speakerOriginOf(speaker: Pick<ContentSpeaker, "id" | "origin">, contentOrigin: string): { contentId: string; speakerId: string } {
  return speaker.origin ?? { contentId: contentOrigin, speakerId: speaker.id };
}
