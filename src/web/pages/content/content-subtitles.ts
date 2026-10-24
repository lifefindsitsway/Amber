import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContentDetailDto, TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import { sliceCues, subtitleCues } from "../../../shared/subtitle-geometry.ts";
import { useMe } from "../../api/queries.ts";
import { useSubtitleFontFallback } from "../../player/subtitle-font.ts";
import type { SubtitleStatus, SubtitleTrackModel } from "../../player/subtitle-overlay.tsx";
import { useSubtitlePrefs, type SubtitleDisplayMode, type SubtitleTrackPref } from "../../player/subtitle-prefs.ts";
import { useContentPage } from "./content-context.tsx";
import { readableRevisions, useRevisions, useSegments, visibleRevisions } from "./content-data.ts";
import { translationsOf } from "./export-dialog.tsx";
import { revisionLabel } from "./labels.ts";

const usesOriginal = (mode: SubtitleDisplayMode): boolean => mode === "original" || mode === "bilingual";
const usesTranslation = (mode: SubtitleDisplayMode): boolean => mode === "translation" || mode === "bilingual";

function present(id: string | undefined, revisions: readonly TranscriptRevisionDto[]): string | undefined {
  return id !== undefined && revisions.some((revision) => revision.id === id) ? id : undefined;
}

function latest(revisions: readonly TranscriptRevisionDto[]): TranscriptRevisionDto | undefined {
  return revisions.reduce<TranscriptRevisionDto | undefined>((best, revision) => (best === undefined || revision.createdAt > best.createdAt ? revision : best), undefined);
}

/**
 * The local player's subtitles for a Content, assembled here so the player
 * never reads Content data. The original is the remembered revision while it still exists,
 * else the primary; the translation is the remembered one while it still translates that
 * original, else its newest translation. A mode needing a translation the original lacks
 * shows the original. Only the revisions the mode shows are read; switching revisions
 * abandons the old read. Each `editRequest` bump (the page's 「样式与位置」 entry) turns
 * subtitles on if needed and opens the editor. Undefined until the user is known, since
 * every preference is per user.
 */
export function useContentSubtitles(content: ContentDetailDto, editRequest: number): SubtitleTrackModel | undefined {
  const { t, i18n } = useTranslation();
  const { openTab } = useContentPage();
  const me = useMe();
  const userId = me.data?.userId;
  const prefs = useSubtitlePrefs(userId ?? "", content.id);
  const revisions = useRevisions(content.id);
  const all = useMemo(() => revisions.data?.revisions ?? [], [revisions.data]);
  const primaryId = revisions.data?.primaryTranscriptRevisionId;
  const readable = useMemo(() => readableRevisions(all), [all]);
  const track = prefs.track;
  const originalId = present(track.revisionId, readable) ?? present(primaryId, readable) ?? readable.at(-1)?.id;
  // The picker lists what the version pickers list, plus the original being shown.
  const pickable = useMemo(() => visibleRevisions(readable, primaryId, { include: [originalId] }), [readable, primaryId, originalId]);
  const translations = useMemo(() => translationsOf(originalId, all), [originalId, all]);
  const translationId = present(track.translationRevisionId, translations) ?? latest(translations)?.id;
  const mode: SubtitleDisplayMode = usesTranslation(track.mode) && translationId === undefined ? "original" : track.mode;
  const on = mode !== "off";
  const [editing, setEditing] = useState(false);

  const originalSegments = useSegments(on && usesOriginal(mode) ? originalId : undefined);
  const translationSegments = useSegments(on && usesTranslation(mode) ? translationId : undefined);
  const fontFallback = useSubtitleFontFallback(on);
  const slices = useMemo(
    () => (mode === "off" ? [] : sliceCues(subtitleCues(mode, originalSegments.data ?? [], translationSegments.data ?? []))),
    [mode, originalSegments.data, translationSegments.data],
  );

  const reads = [...(usesOriginal(mode) ? [originalSegments] : []), ...(usesTranslation(mode) ? [translationSegments] : [])];
  let status: SubtitleStatus;
  if (!on) status = "off";
  else if (revisions.isError) status = "error";
  else if (revisions.isPending) status = "loading";
  else if (originalId === undefined) status = "empty";
  else if (reads.some((read) => read.isError)) status = "error";
  else if (reads.some((read) => read.isPending)) status = "loading";
  else status = slices.length === 0 ? "empty" : "ready";

  const remembered = (next: Partial<Omit<SubtitleTrackPref, "version">>): SubtitleTrackPref => {
    const merged = { mode: track.mode, revisionId: track.revisionId, translationRevisionId: track.translationRevisionId, ...next };
    return {
      version: 1,
      mode: merged.mode,
      ...(merged.revisionId === undefined ? {} : { revisionId: merged.revisionId }),
      ...(merged.translationRevisionId === undefined ? {} : { translationRevisionId: merged.translationRevisionId }),
    };
  };
  const setMode = (next: SubtitleDisplayMode): void => {
    prefs.setTrack(remembered({ mode: next }));
    if (next === "off") setEditing(false);
  };
  const startEditing = (): void => {
    if (mode === "off") prefs.setTrack(remembered({ mode: translationId === undefined ? "original" : "bilingual" }));
    setEditing(true);
  };

  const seenRequest = useRef(editRequest);
  useEffect(() => {
    // Preferences are per user: a request made before the user is known waits for them.
    if (editRequest === seenRequest.current || userId === undefined) return;
    seenRequest.current = editRequest;
    // Only a new request acts, and the closure of the render that saw it is the current one.
    startEditing();
  }, [editRequest, userId]);

  if (userId === undefined) return undefined;
  return {
    mode,
    setMode,
    originals: pickable.map((revision) => ({ id: revision.id, label: revisionLabel(revision, primaryId, t, i18n, readable) })),
    originalId,
    // A translation belongs to its original, so picking another original forgets it.
    setOriginal: (id) => prefs.setTrack({ version: 1, mode: track.mode, revisionId: id }),
    translations: translations.map((revision) => ({ id: revision.id, label: revisionLabel(revision, primaryId, t, i18n, translations) })),
    translationId,
    setTranslation: (id) => prefs.setTrack(remembered({ translationRevisionId: id, ...(originalId === undefined ? {} : { revisionId: originalId }) })),
    goTranslate: () => openTab("translation"),
    status,
    retry: () => {
      if (revisions.isError) {
        void revisions.refetch();
        return;
      }
      for (const read of reads) if (read.isError) void read.refetch();
    },
    slices,
    fontFallback,
    appearance: prefs.appearance,
    setAppearance: prefs.setAppearance,
    resetAppearance: prefs.resetAppearance,
    placement: prefs.placement,
    placementOverridden: prefs.placementOverridden,
    setPlacement: prefs.setPlacement,
    setDefaultPlacement: prefs.setDefaultPlacement,
    resetPlacement: prefs.resetPlacement,
    editing: editing && on,
    startEditing,
    stopEditing: () => setEditing(false),
  };
}
