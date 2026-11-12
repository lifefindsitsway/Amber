import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContentDetailDto, TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import { labelSubtitleCues, sliceCues, sliceSubtitleUnits, subtitleCues, subtitleSpeakerLabel } from "../../../shared/subtitle-geometry.ts";
import { useMe } from "../../api/queries.ts";
import { useSubtitleFontFallback } from "../../player/subtitle-font.ts";
import type { SubtitleStatus, SubtitleTrackModel, SubtitleTranslationLanguage } from "../../player/subtitle-overlay.tsx";
import { upgradeTrackPref, useSubtitlePrefs, type SubtitleDisplayMode, type SubtitleTrackPref } from "../../player/subtitle-prefs.ts";
import { useContentPage } from "./content-context.tsx";
import { pickTranslation, readableRevisions, translationCurrents, useRevisions, useSegments, useTranslations, visibleRevisions } from "./content-data.ts";
import { languageLabel, revisionLabel } from "./labels.ts";
import { speakerLabel, useSpeakers } from "./speakers/speaker-data.ts";

const usesOriginal = (mode: SubtitleDisplayMode): boolean => mode === "original" || mode === "bilingual";
const usesTranslation = (mode: SubtitleDisplayMode): boolean => mode === "translation" || mode === "bilingual";

function present(id: string | undefined, revisions: readonly TranscriptRevisionDto[]): string | undefined {
  return id !== undefined && revisions.some((revision) => revision.id === id) ? id : undefined;
}

/**
 * The local player's subtitles for a Content, assembled here so the player
 * never reads Content data. The original is the remembered revision while it still exists,
 * else the primary; the translation is `pickTranslation`'s choice for that original under the
 * remembered language or lock. A mode needing a translation the original lacks shows the
 * original. Only the revisions the mode shows are read; switching revisions
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
  const track = useMemo(() => upgradeTrackPref(prefs.track, all), [prefs.track, all]);
  const translationList = useTranslations(content.id);
  // A failed list only loses the currents: each language then shows its newest translation.
  const currents = useMemo(() => translationCurrents(translationList.data?.translations), [translationList.data]);
  const originalId = present(track.revisionId, readable) ?? present(primaryId, readable) ?? readable.at(-1)?.id;
  // The picker lists what the version pickers list, plus the original being shown.
  const pickable = useMemo(() => visibleRevisions(readable, primaryId, { include: [originalId] }), [readable, primaryId, originalId]);
  // Until the currents are known the pick could still move, so no translation is read yet.
  const currentsKnown = !translationList.isPending;
  const picked = currentsKnown
    ? pickTranslation({ originalId, language: track.translation?.language, lockedRevisionId: track.translation?.lockedRevisionId, revisions: all, currents })
    : undefined;
  const translationId = picked?.id;
  const translationLocked = picked !== undefined && picked.id === track.translation?.lockedRevisionId;
  const lockedId = translationLocked ? translationId : undefined;
  const languages = useMemo(() => translationLanguages(originalId, all, currents, lockedId), [originalId, all, currents, lockedId]);
  const mode: SubtitleDisplayMode = usesTranslation(track.mode) && currentsKnown && translationId === undefined ? "original" : track.mode;
  const on = mode !== "off";
  const [editing, setEditing] = useState(false);

  const originalSegments = useSegments(on && usesOriginal(mode) ? originalId : undefined);
  const translationSegments = useSegments(on && usesTranslation(mode) ? translationId : undefined);
  const fontFallback = useSubtitleFontFallback(on);
  const speakerMode = prefs.appearance.speaker;
  const labelsOn = on && speakerMode !== undefined;
  // Cues wait for the speakers, so a label never appears on a cue already on screen; a failed read shows them without labels.
  const speakers = useSpeakers(content.id, labelsOn);
  const speakersPending = labelsOn && speakers.isPending;
  // Kept by value: re-reading the speakers (a new avatar, a colour) re-slices nothing, so the cues on screen stay as they are.
  const labelsKey = JSON.stringify((speakers.data?.items ?? []).map((speaker) => [speaker.id, subtitleSpeakerLabel(speakerLabel(t, speaker))]));
  const labels = useMemo(() => new Map<string, string>(JSON.parse(labelsKey) as Array<[string, string]>), [labelsKey]);
  // With labels off the plain slices are cut exactly as before; with them on, each cue stays a unit with its speaker.
  const units = useMemo(() => {
    if (mode === "off" || speakerMode === undefined) return undefined;
    if (speakersPending) return [];
    const original = originalSegments.data ?? [];
    const translation = translationSegments.data ?? [];
    const shown = mode === "translation" ? translation : original;
    return sliceSubtitleUnits(labelSubtitleCues(subtitleCues(mode, original, translation), shown.map((segment) => segment.speakerId), labels, speakerMode));
  }, [mode, speakerMode, speakersPending, originalSegments.data, translationSegments.data, labels]);
  const slices = useMemo(
    () => (mode === "off" || units !== undefined ? [] : sliceCues(subtitleCues(mode, originalSegments.data ?? [], translationSegments.data ?? []))),
    [mode, units, originalSegments.data, translationSegments.data],
  );

  const reads = [...(usesOriginal(mode) ? [originalSegments] : []), ...(usesTranslation(mode) ? [translationSegments] : [])];
  let status: SubtitleStatus;
  if (!on) status = "off";
  else if (revisions.isError) status = "error";
  else if (revisions.isPending) status = "loading";
  else if (originalId === undefined) status = "empty";
  else if (usesTranslation(mode) && !currentsKnown) status = "loading";
  else if (reads.some((read) => read.isError)) status = "error";
  else if (reads.some((read) => read.isPending)) status = "loading";
  else if (speakersPending) status = "loading";
  else status = (units ?? slices).length === 0 ? "empty" : "ready";

  const remembered = (next: Partial<Omit<SubtitleTrackPref, "version">>): SubtitleTrackPref => {
    const merged = { mode: track.mode, revisionId: track.revisionId, translation: track.translation, ...next };
    return {
      version: 2,
      mode: merged.mode,
      ...(merged.revisionId === undefined ? {} : { revisionId: merged.revisionId }),
      ...(merged.translation === undefined ? {} : { translation: merged.translation }),
    };
  };
  // A translation belongs to its original, so the original being shown is remembered with it.
  const shownOriginal = originalId === undefined ? {} : { revisionId: originalId };
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
    // A locked version belongs to its original, so picking another original keeps only the language.
    setOriginal: (id) =>
      prefs.setTrack({ version: 2, mode: track.mode, revisionId: id, ...(track.translation === undefined ? {} : { translation: { language: track.translation.language } }) }),
    translations: languages.map((entry) => ({
      language: entry.language,
      label: languageLabel(entry.language, t, i18n),
      currentId: entry.currentId,
      history: entry.history.map((revision) => ({ id: revision.id, label: revisionLabel(revision, undefined, t, i18n, entry.history) })),
    })),
    translationId,
    translationLocked,
    followTranslation: (language) => prefs.setTrack(remembered({ translation: { language }, ...shownOriginal })),
    lockTranslation: (id) => {
      const revision = all.find((item) => item.id === id && item.kind === "translated");
      if (revision !== undefined) prefs.setTrack(remembered({ translation: { language: revision.language, lockedRevisionId: id }, ...shownOriginal }));
    },
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
    ...(units === undefined ? {} : { units }),
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

/**
 * The menu's languages for an original: each language with a candidate translation, the
 * version following it shows, and its other versions (newest first) to lock. A locked version
 * that is also its language's current one is listed among them too, so the menu shows the lock
 * apart from following. Languages keep the order their first candidate was made in.
 */
export function translationLanguages<T extends TranscriptRevisionDto & { archived?: boolean }>(
  originalId: string | undefined,
  revisions: readonly T[],
  currents: Readonly<Record<string, string | undefined>>,
  lockedId?: string,
): Array<Omit<SubtitleTranslationLanguage, "label" | "history"> & { history: T[] }> {
  const candidates = revisions
    .filter((revision) => revision.kind === "translated" && revision.archived !== true && originalId !== undefined && revision.parentRevisionId === originalId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const languages = [...new Set(candidates.map((revision) => revision.language))];
  return languages.flatMap((language) => {
    const current = pickTranslation({ originalId, language, revisions: candidates, currents });
    if (current === undefined) return [];
    const history = candidates.filter((revision) => revision.language === language && (revision.id !== current.id || revision.id === lockedId)).reverse();
    return [{ language, currentId: current.id, history }];
  });
}
