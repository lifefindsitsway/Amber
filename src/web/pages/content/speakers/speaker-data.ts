import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { z } from "zod";
import {
  speakerDtoSchema,
  speakerListDtoSchema,
  speakerSuggestionListDtoSchema,
  type SpeakerCreateRequest,
  type SpeakerDto,
  type SpeakerListDto,
  type SpeakerPatchRequest,
} from "../../../../shared/dto/speaker.ts";
import { normalizeSpeakerName } from "../../../../shared/speakers.ts";
import { ApiError } from "../../../api/client.ts";
import { speakerReviewDtoSchema, type SpeakersConfirmedRequest } from "../../../../shared/dto/transcript.ts";
import { graphemesOf } from "../../../../shared/speakers.ts";
import { useApi, useContentEvents } from "../../../api/context.tsx";
import { publishSpeakerReviewChanged, publishSpeakersChanged } from "../../../api/content-events.ts";
import { queryString } from "../../../api/queries.ts";
import { contentKeys } from "../content-data.ts";

const speakersPath = (contentId: string): string => `/api/contents/${encodeURIComponent(contentId)}/speakers`;

const reviewPath = (revisionId: string): string => `/api/transcript/revisions/${encodeURIComponent(revisionId)}`;

/** Query key of the suggestions for a typed name; they are the user's own data, shared by every Content. */
export const speakerSuggestionKeys = {
  all: ["speaker-suggestions"] as const,
  query: (query: string, contentId: string) => ["speaker-suggestions", contentId, query] as const,
};

/** The Content's speakers in ordinal order, `used` or not (the caller decides what to show). */
export function useSpeakers(contentId: string, enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.speakers(contentId),
    queryFn: () => client.get(speakersPath(contentId), speakerListDtoSchema),
    enabled,
  });
}

/**
 * The creation request for what the user typed: a name typed by the user is their own word for
 * who this is, so it is sent as confirmed; a blank one leaves the speaker unnamed (shown as
 * 「发言人 N」).
 */
export function speakerCreateRequest(typed: string): SpeakerCreateRequest {
  const name = normalizeSpeakerName(typed);
  return name === undefined || name === "too_long" ? {} : { name, nameConfirmed: true };
}

/**
 * Creates a speaker. The new one is put into the cached list at once (a caller assigning it
 * right away must find it there), then the list is read again here and in other windows.
 */
export function useCreateSpeaker(contentId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  return useMutation({
    mutationFn: (request: SpeakerCreateRequest) => client.post(speakersPath(contentId), speakerDtoSchema, { body: request }),
    onSuccess: (speaker) => {
      queryClient.setQueryData<SpeakerListDto>(contentKeys.speakers(contentId), (list) =>
        list === undefined ? list : { items: [...list.items.filter((item) => item.id !== speaker.id), speaker].sort((a, b) => a.ordinal - b.ordinal) },
      );
      publishSpeakersChanged(events, queryClient, contentId);
      // A named speaker is a suggestion for the user's other Contents.
      void queryClient.invalidateQueries({ queryKey: speakerSuggestionKeys.all });
    },
  });
}

/** Why a deletion was refused, when the refusal is one the panel explains rather than shows as an error. */
export type SpeakerDeleteRefusal = "in_use" | "gone";

/** The refusal a failed deletion stands for; `undefined` for any other failure. */
export function speakerDeleteRefusal(error: unknown): SpeakerDeleteRefusal | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.error.code === "conflict.speaker_in_use") return "in_use";
  if (error.status === 404 || error.error.class === "not_found") return "gone";
  return undefined;
}

const forgetSpeaker = (queryClient: QueryClient, contentId: string, speakerId: string): void => {
  queryClient.setQueryData<SpeakerListDto>(contentKeys.speakers(contentId), (list) => (list === undefined ? list : { items: list.items.filter((item) => item.id !== speakerId) }));
};

/**
 * Deletes a speaker nothing refers to. The server checks again in its own transaction: a
 * speaker some version or draft names after all is refused (`conflict.speaker_in_use`), one
 * that is already gone is `not_found`; either way the list is read again, so what the panel
 * shows matches the server. A deletion also changes the name suggestions and what reviews
 * count, and other windows are told.
 */
export function useDeleteSpeaker(contentId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  return useMutation({
    mutationFn: (speakerId: string) => client.delete(`${speakersPath(contentId)}/${encodeURIComponent(speakerId)}`, z.undefined()).then(() => speakerId),
    onSuccess: (speakerId) => {
      forgetSpeaker(queryClient, contentId, speakerId);
      publishSpeakersChanged(events, queryClient, contentId);
      void queryClient.invalidateQueries({ queryKey: speakerSuggestionKeys.all });
    },
    onError: (error, speakerId) => {
      const refusal = speakerDeleteRefusal(error);
      if (refusal === "gone") forgetSpeaker(queryClient, contentId, speakerId);
      if (refusal !== undefined) publishSpeakersChanged(events, queryClient, contentId);
    },
  });
}

/** What `usePatchSpeaker` is called with: the speaker and the change (fields, or a copy of another speaker). */
export interface SpeakerPatchInput {
  speakerId: string;
  patch: SpeakerPatchRequest;
}

/** Renames, recolours or re-photographs a speaker, or copies another one onto it. */
export function usePatchSpeaker(contentId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  return useMutation({
    mutationFn: (input: SpeakerPatchInput) => client.patch(`${speakersPath(contentId)}/${encodeURIComponent(input.speakerId)}`, speakerDtoSchema, { body: input.patch }),
    onSuccess: () => {
      publishSpeakersChanged(events, queryClient, contentId);
      // A copied speaker's suggestions may now rank differently.
      void queryClient.invalidateQueries({ queryKey: speakerSuggestionKeys.all });
    },
  });
}

/**
 * The review of one revision's speakers: counts, unconfirmed names, and the roster digest a
 * confirmation sends back. Only for revisions that name speakers (others are refused).
 */
export function useSpeakerReview(contentId: string, revisionId: string | undefined) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.speakerReview(contentId, revisionId ?? ""),
    queryFn: () => client.get(`${reviewPath(revisionId as string)}/speaker-review`, speakerReviewDtoSchema),
    enabled: revisionId !== undefined,
  });
}

/**
 * Marks a revision's speakers as reviewed (which also confirms the names shown), or takes
 * the mark back. The names and reviews it changes are read again here and in other windows;
 * the revision list, which shows the mark too, is read again here.
 */
export function useSetSpeakersConfirmed(contentId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  return useMutation({
    mutationFn: (input: { revisionId: string; request: SpeakersConfirmedRequest }) =>
      client.put(`${reviewPath(input.revisionId)}/speakers-confirmed`, speakerReviewDtoSchema, { body: input.request }),
    onSuccess: (review) => {
      queryClient.setQueryData(contentKeys.speakerReview(contentId, review.revisionId), review);
      publishSpeakerReviewChanged(events, queryClient, contentId);
    },
  });
}

/**
 * Named speakers of the user's other Contents matching what is typed (all recent ones for an
 * empty query). The Content being edited is sent so the server leaves its own speakers out.
 * `enabled` keeps the list unrequested until the edit form is open.
 */
export function useSpeakerSuggestions(query: string, contentId: string, enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: speakerSuggestionKeys.query(query, contentId),
    queryFn: () => client.get(`/api/speakers/suggestions${queryString({ q: query, contentId })}`, speakerSuggestionListDtoSchema),
    enabled,
    staleTime: 30_000,
  });
}

/** What a speaker is called on screen: its name, else "发言人 N" by ordinal. */
export function speakerLabel(t: TFunction, speaker: Pick<SpeakerDto, "name" | "ordinal">): string {
  return speaker.name ?? t("speakerIdentity.unnamed", { ordinal: speaker.ordinal });
}

// Mirrors the cleaning `normalizeSpeakerName` does before it counts: control and
// bidirectional formatting characters become spaces, white space collapses, the ends are
// trimmed. A test pins the two together, so the counter below shows the length that is
// compared against the limit.
const CONTROLS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** The number of characters (grapheme clusters) a typed name will count as once stored. */
export function speakerNameLength(raw: string): number {
  const cleaned = raw.replace(CONTROLS, " ").replace(/\s+/gu, " ").trim();
  return cleaned === "" ? 0 : graphemesOf(cleaned).length;
}
