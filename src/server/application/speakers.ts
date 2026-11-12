import { monotonicFactory } from "ulid";
import { SPEAKER_SUGGESTIONS_MAX, SPEAKERS_PER_CONTENT_MAX } from "../../shared/defaults.ts";
import type {
  SpeakerCreateRequest,
  SpeakerDto,
  SpeakerListDto,
  SpeakerPatchRequest,
  SpeakerSuggestionListDto,
} from "../../shared/dto/speaker.ts";
import type { SpeakerReviewDto, SpeakersConfirmedRequest } from "../../shared/dto/transcript.ts";
import { normalizeSpeakerName } from "../../shared/speakers.ts";
import { amberError } from "../domain/errors.ts";
import type { ContentSpeaker, SpeakerAvatar } from "../domain/speaker.ts";
import { inspectSpeakerAvatar } from "../domain/speaker-avatar.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope, SpeakerPatch } from "../ports/repository.ts";
import { nameIsConfirmed, setSpeakersConfirmed, speakerReviewOf } from "./speaker-review.ts";
import { ownedContent } from "./transcripts.ts";

export interface SpeakerServiceOptions {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

/** A stored photo with the version that keys its cache entry. */
export interface SpeakerAvatarFile extends SpeakerAvatar {
  version: number;
}

function speakerDto(speaker: ContentSpeaker, used: boolean, comparisonOnly: boolean): SpeakerDto {
  return {
    id: speaker.id,
    ordinal: speaker.ordinal,
    ...(speaker.name === undefined ? {} : { name: speaker.name }),
    colorIndex: speaker.colorIndex,
    ...(speaker.avatar === undefined ? {} : { avatarVersion: speaker.avatar.version }),
    used,
    ...(nameIsConfirmed(speaker) ? { nameConfirmed: true } : {}),
    ...(comparisonOnly ? { comparisonOnly: true } : {}),
  };
}

/**
 * How a change of name affects its confirmation. A request confirms a name only while it
 * writes one (`name` present, the current name re-sent included, or a copied name) and says
 * so (`nameConfirmed: true`): the confirmation is the caller vouching for the name it is
 * saving, so a request that only changes colour or photo, or sends the flag alone, leaves
 * the existing name's confirmation as it is. A name that changes without the flag becomes
 * unconfirmed whoever the caller is, and an unnamed speaker has nothing confirmed.
 * Re-sending the current name without the flag changes nothing. `undefined` = leave the
 * confirmation as it is.
 */
function nameConfirmationAfter(current: ContentSpeaker, name: string | null | undefined, confirm: boolean, now: number): number | null | undefined {
  const next = name === undefined ? current.name : (name ?? undefined);
  if (next === undefined) {
    return current.nameConfirmedAt === undefined ? undefined : null;
  }
  if (confirm && name !== undefined) {
    return now;
  }
  return next === current.name ? undefined : null;
}

/** `undefined` = unnamed; a name over the limit is refused, never cut. */
function storedName(raw: string, detail: string): string | undefined {
  const name = normalizeSpeakerName(raw);
  if (name === "too_long") {
    throw amberError("invalid_request", "speaker name is too long", { params: { detail } });
  }
  return name;
}

function ownedSpeaker(scope: RepositoryScope, owner: string, contentId: string, speakerId: string): ContentSpeaker {
  const speaker = scope.speakers.get(owner, contentId, speakerId);
  if (speaker === undefined) {
    throw amberError("not_found", "speaker not found");
  }
  return speaker;
}

/**
 * Speaker identities of a Content: naming, coloring and photographing them, and copying one
 * from another of the user's Contents. Every call is scoped to the principal; a foreign or
 * trashed Content, or a speaker of another Content, is `not_found`.
 */
export class SpeakerService {
  private readonly options: SpeakerServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: SpeakerServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /**
   * In `ordinal` order; `used` marks the ones some unarchived revision or the draft names,
   * `comparisonOnly` the ones only comparison transcriptions name.
   */
  list(principal: RequestPrincipal, contentId: string): SpeakerListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      const used = scope.speakers.usedIds(owner, contentId);
      const comparisonOnly = scope.speakers.comparisonOnlyIds(owner, contentId);
      return { items: scope.speakers.list(owner, contentId).map((speaker) => speakerDto(speaker, used.has(speaker.id), comparisonOnly.has(speaker.id))) };
    });
  }

  create(principal: RequestPrincipal, contentId: string, body: SpeakerCreateRequest): SpeakerDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      const name = body.name === undefined ? undefined : storedName(body.name, "body.name");
      if (scope.speakers.count(owner, contentId) >= SPEAKERS_PER_CONTENT_MAX) {
        throw amberError("invalid_request", "the content already has the most speakers it may have", { params: { detail: "speakers" } });
      }
      const now = this.now();
      const [created] = scope.speakers.insert(
        owner,
        contentId,
        [
          {
            id: this.newId(),
            ...(name === undefined ? {} : { name }),
            ...(name !== undefined && body.nameConfirmed === true ? { nameConfirmedAt: now } : {}),
            ...(body.colorIndex === undefined ? {} : { colorIndex: body.colorIndex }),
          },
        ],
        now,
      );
      return speakerDto(created as ContentSpeaker, false, false);
    });
  }

  /**
   * Changes a speaker's name, color or photo, or copies another speaker of the user's:
   * name, color and photo as they are now, with no link kept. A photo is judged by its bytes
   * (the type the client declares is not used) before anything is written. The name's
   * confirmation follows `nameConfirmationAfter`; a copied name counts as a new name.
   */
  patch(principal: RequestPrincipal, contentId: string, speakerId: string, body: SpeakerPatchRequest): SpeakerDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      const current = ownedSpeaker(scope, owner, contentId, speakerId);
      const change = "copyFrom" in body ? this.copyOf(scope, owner, body.copyFrom) : this.changeOf(body);
      const now = this.now();
      const confirmedAt = nameConfirmationAfter(current, change.name, body.nameConfirmed === true, now);
      if (confirmedAt !== undefined) {
        change.nameConfirmedAt = confirmedAt;
      }
      const updated = scope.speakers.update(owner, contentId, speakerId, change, now) ?? current;
      return speakerDto(updated, scope.speakers.usedIds(owner, contentId).has(updated.id), scope.speakers.comparisonOnlyIds(owner, contentId).has(updated.id));
    });
  }

  /**
   * What the review of one revision's speakers shows: who speaks how much, what is still
   * unassigned or unconfirmed, and the roster digest a confirmation must send back. A
   * translation, or a revision whose sentences name nobody, has nothing to review.
   */
  review(principal: RequestPrincipal, revisionId: string): SpeakerReviewDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => speakerReviewOf(scope, owner, revisionId));
  }

  /** Marks a revision's speakers as reviewed (confirming the names it shows), or takes the mark back; see `setSpeakersConfirmed`. */
  setRevisionConfirmed(principal: RequestPrincipal, revisionId: string, body: SpeakersConfirmedRequest): SpeakerReviewDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => setSpeakersConfirmed(scope, owner, revisionId, body, this.now()));
  }

  /** The photo bytes and type with the version that identifies them; `not_found` when there is none. */
  avatar(principal: RequestPrincipal, contentId: string, speakerId: string): SpeakerAvatarFile {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      const avatar = scope.speakers.getAvatar(owner, contentId, speakerId);
      if (avatar === undefined) {
        throw amberError("not_found", "speaker has no photo");
      }
      return avatar;
    });
  }

  /**
   * Named speakers of the user's other Contents whose name contains `query`, newest change
   * first. `excludeContentId` leaves one Content's own speakers out (the one being edited);
   * it only filters, so an id that is unknown or someone else's reveals nothing.
   */
  suggestions(principal: RequestPrincipal, query: string, excludeContentId?: string): SpeakerSuggestionListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => ({
      items: scope.speakers.suggestions(owner, query, excludeContentId, SPEAKER_SUGGESTIONS_MAX).flatMap((speaker) =>
        speaker.name === undefined
          ? []
          : [
              {
                contentId: speaker.contentId,
                speakerId: speaker.id,
                name: speaker.name,
                colorIndex: speaker.colorIndex,
                ...(speaker.avatar === undefined ? {} : { avatarVersion: speaker.avatar.version }),
                ...(speaker.contentTitle === undefined ? {} : { contentTitle: speaker.contentTitle }),
              },
            ],
      ),
    }));
  }

  private changeOf(body: Exclude<SpeakerPatchRequest, { copyFrom: unknown }>): SpeakerPatch {
    const change: SpeakerPatch = {};
    if (body.name !== undefined) {
      change.name = body.name === null ? null : (storedName(body.name, "body.name") ?? null);
    }
    if (body.colorIndex !== undefined) {
      change.colorIndex = body.colorIndex;
    }
    if (body.avatar !== undefined) {
      if (body.avatar === null) {
        change.avatar = null;
      } else {
        const bytes = new Uint8Array(Buffer.from(body.avatar.data, "base64"));
        const verdict = inspectSpeakerAvatar(bytes);
        if (!verdict.ok) {
          throw amberError("invalid_request", `speaker photo refused: ${verdict.reason}`, { params: { detail: "body.avatar" } });
        }
        change.avatar = { mime: verdict.mime, bytes };
      }
    }
    return change;
  }

  private copyOf(scope: RepositoryScope, owner: string, from: { contentId: string; speakerId: string }): SpeakerPatch {
    ownedContent(scope, owner, from.contentId);
    const source = ownedSpeaker(scope, owner, from.contentId, from.speakerId);
    const photo = scope.speakers.getAvatar(owner, from.contentId, from.speakerId);
    return {
      name: source.name ?? null,
      colorIndex: source.colorIndex,
      avatar: photo === undefined ? null : { mime: photo.mime, bytes: new Uint8Array(photo.bytes) },
    };
  }
}
