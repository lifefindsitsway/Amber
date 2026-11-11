import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { speakerDtoSchema, speakerListDtoSchema, speakerSuggestionListDtoSchema, type SpeakerCreateRequest, type SpeakerDto, type SpeakerPatchRequest } from "../../../../shared/dto/speaker.ts";
import { graphemesOf } from "../../../../shared/speakers.ts";
import { useApi, useContentEvents } from "../../../api/context.tsx";
import { publishSpeakersChanged } from "../../../api/content-events.ts";
import { queryString } from "../../../api/queries.ts";
import { contentKeys } from "../content-data.ts";

const speakersPath = (contentId: string): string => `/api/contents/${encodeURIComponent(contentId)}/speakers`;

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

/** Creates a speaker; other windows are told so they re-read the list. */
export function useCreateSpeaker(contentId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  return useMutation({
    mutationFn: (request: SpeakerCreateRequest) => client.post(speakersPath(contentId), speakerDtoSchema, { body: request }),
    onSuccess: () => {
      publishSpeakersChanged(events, queryClient, contentId);
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
