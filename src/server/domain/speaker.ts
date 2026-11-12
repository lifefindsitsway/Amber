import type { SpeakerAvatarMime } from "../../shared/dto/speaker.ts";

/**
 * A speaker identity within one Content. Sentences store only its id, so renaming changes how
 * every revision of the Content shows the speaker. Ids are ULIDs except for labels carried
 * over from databases written before speakers had identities, which keep their label.
 * Invariant: `(contentId, id)` and `(contentId, ordinal)` are unique; a speaker belongs to the
 * owner of its Content and is deleted with it.
 */
export interface ContentSpeaker {
  contentId: string;
  id: string;
  userId: string;
  /** From 1 within the Content: the N of the default name 「发言人 N」. */
  ordinal: number;
  /** Normalized; absent = unnamed. */
  name?: string;
  /**
   * When the name was confirmed as this person's name. Only a confirmed name is given to a
   * model; a name written without the confirmation (by any caller) leaves this absent, and
   * the speaker is then presented by its ordinal.
   */
  nameConfirmedAt?: number;
  colorIndex: number;
  /** Present when the speaker has a photo; `version` changes with every new photo. */
  avatar?: { mime: SpeakerAvatarMime; version: number };
  createdAt: number;
  updatedAt: number;
}

/** A speaker photo as stored: already checked for type, dimensions and size. */
export interface SpeakerAvatar {
  mime: SpeakerAvatarMime;
  bytes: Uint8Array;
}
