import { SPEAKERS_PER_CONTENT_MAX } from "../../../shared/defaults.ts";
import type { SubtitleImportOptions, SubtitleInspectResponse } from "../../../shared/dto/subtitle-import.ts";
import { normalizeSpeakerName } from "../../../shared/speakers.ts";

/**
 * What the user chose in a subtitle import preview, and the pure rules that turn a preview and
 * that choice into counts, warnings and the import `options`. Changing a choice never asks the
 * server again: everything here is computed from the preview alone.
 */

export type SubtitlePreview = SubtitleInspectResponse;
export type SpeakerCandidate = SubtitlePreview["speakers"]["candidates"][number];
export type ExistingSpeaker = NonNullable<SubtitlePreview["target"]>["speakers"][number];

/** How SRT cues without a chosen leading name are attributed. */
export type UnlabeledRule = "inherit" | "unassigned";

export interface SubtitleImportChoice {
  /** SRT only: the candidate keys taken as speakers; the other leading names stay in the text. */
  prefixNames: readonly string[];
  unlabeled: UnlabeledRule;
  /**
   * The language of the translation lines the file carries without naming one: a tag, `null`
   * for 「不导入译文」, `undefined` while the user has not picked yet.
   */
  translation: string | null | undefined;
  /** Existing Content only: candidate key → the existing speaker it continues; absent = a new speaker. */
  identities: Readonly<Record<string, string>>;
  /** Existing Content only: make the import the primary and its translations current. */
  setCurrent: boolean;
}

/** Why the import cannot start with the current choice. */
export type ImportBlocker = "speaker_capacity" | "translation_language" | "translation_same_language";

/**
 * The starting choice for a preview: the preselected SRT names, earlier speakers continuing,
 * and translation lines of an SRT left out (the second line is only a suggestion), while the
 * translation style of an ASS waits for a language.
 */
export function initialImportChoice(preview: SubtitlePreview): SubtitleImportChoice {
  const bilingual = preview.bilingual;
  return {
    prefixNames: preview.speakers.source === "prefix" ? preview.speakers.candidates.filter((candidate) => candidate.preselected).map((candidate) => candidate.key) : [],
    unlabeled: "inherit",
    translation: bilingual !== undefined && knownTranslationLanguages(preview) === undefined && bilingual.source === "lines" ? null : undefined,
    identities: {},
    setCurrent: true,
  };
}

/** Labelled, inherited (inferred) and unassigned cue counts for a set of chosen candidates. */
export interface AttributionCounts {
  labelled: number;
  inherited: number;
  unassigned: number;
}

/**
 * Recounts the cues from the preview's runs: a cue whose candidate is chosen is labelled; any
 * other cue (no label, or a name left in the text) continues the last labelled speaker under
 * `inherit` once one has appeared, and is unassigned otherwise.
 */
export function countAttribution(sequence: SubtitlePreview["speakers"]["sequence"], chosen: ReadonlySet<number>, rule: UnlabeledRule): AttributionCounts {
  const counts: AttributionCounts = { labelled: 0, inherited: 0, unassigned: 0 };
  let seenLabel = false;
  for (const [index, length] of sequence) {
    if (index >= 0 && chosen.has(index)) {
      counts.labelled += length;
      seenLabel = true;
    } else if (rule === "inherit" && seenLabel) {
      counts.inherited += length;
    } else {
      counts.unassigned += length;
    }
  }
  return counts;
}

/** The counts the preview shows for the current choice; explicit sources never infer. */
export function attributionOf(preview: SubtitlePreview, choice: SubtitleImportChoice): AttributionCounts {
  const { source, candidates, sequence } = preview.speakers;
  if (source === "prefix") {
    const chosen = new Set(choice.prefixNames);
    return countAttribution(sequence, new Set(candidates.flatMap((candidate, index) => (chosen.has(candidate.key) ? [index] : []))), choice.unlabeled);
  }
  return countAttribution(sequence, new Set(candidates.map((_, index) => index)), "unassigned");
}

/** The candidates that become speakers: the chosen SRT names, or every speaker an explicit source names. */
export function importedSpeakers(preview: SubtitlePreview, choice: SubtitleImportChoice): SpeakerCandidate[] {
  const { source, candidates } = preview.speakers;
  if (source === "none") return [];
  if (source === "prefix") {
    const chosen = new Set(choice.prefixNames);
    return candidates.filter((candidate) => chosen.has(candidate.key));
  }
  return candidates;
}

/** Names compared the way stored names are: cleaned and trimmed; an empty or overlong label matches nothing. */
function comparableName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = normalizeSpeakerName(raw);
  return name === undefined || name === "too_long" ? undefined : name;
}

/** An imported speaker named like one or more existing speakers, each of whom may be continued instead. */
export interface SameNameMatch {
  candidate: SpeakerCandidate;
  existing: ExistingSpeaker[];
}

/** Existing Content only: the imported speakers whose name an existing speaker already has. */
export function sameNameMatches(preview: SubtitlePreview, choice: SubtitleImportChoice): SameNameMatch[] {
  const target = preview.target;
  if (target === undefined) return [];
  return importedSpeakers(preview, choice).flatMap((candidate) => {
    const name = comparableName(candidate.label);
    if (name === undefined) return [];
    const existing = target.speakers.filter((speaker) => comparableName(speaker.name) === name);
    return existing.length === 0 ? [] : [{ candidate, existing }];
  });
}

/**
 * The identities that take effect: a reuse counts only while its candidate is imported, still
 * matches that speaker by name, and no earlier candidate already continues the same speaker.
 */
export function effectiveIdentities(preview: SubtitlePreview, choice: SubtitleImportChoice): Array<{ key: string; speaker: ExistingSpeaker }> {
  const taken = new Set<string>();
  return sameNameMatches(preview, choice).flatMap(({ candidate, existing }) => {
    const speakerId = choice.identities[candidate.key];
    const speaker = existing.find((item) => item.id === speakerId);
    if (speaker === undefined || taken.has(speaker.id)) return [];
    taken.add(speaker.id);
    return [{ key: candidate.key, speaker }];
  });
}

/** How many new speakers the import needs and how many the Content still has room for. */
export function speakerNeed(preview: SubtitlePreview, choice: SubtitleImportChoice): { needed: number; room: number } {
  const imported = importedSpeakers(preview, choice).length;
  // A package names its speakers in the candidates; its own count covers a preview that lists none.
  const total = preview.speakers.source === "package" && imported === 0 ? (preview.package?.speakerCount ?? 0) : imported;
  return { needed: Math.max(0, total - effectiveIdentities(preview, choice).length), room: preview.target?.speakerRoom ?? SPEAKERS_PER_CONTENT_MAX };
}

/** Translation languages the file names itself (a package, or a styled ASS whose restore data held). */
export function knownTranslationLanguages(preview: SubtitlePreview): string[] | undefined {
  if (preview.bilingual?.languages !== undefined) return preview.bilingual.languages;
  const packaged = preview.package?.translationLanguages ?? [];
  return packaged.length > 0 ? packaged : undefined;
}

/** The translation languages the import will bring, in file order. */
export function importedTranslationLanguages(preview: SubtitlePreview, choice: SubtitleImportChoice): string[] {
  const known = knownTranslationLanguages(preview);
  if (known !== undefined) return known;
  return preview.bilingual !== undefined && typeof choice.translation === "string" ? [choice.translation] : [];
}

/** The primary subtag, lower-cased: two tags of one language share it. */
function primaryOf(tag: string): string {
  return (tag.split("-")[0] ?? tag).toLowerCase();
}

/** Whether a translation may be in `language`: never the original's own language (the server refuses it). */
export function translationLanguageAllowed(language: string, originalLanguage: string | undefined): boolean {
  return originalLanguage === undefined || originalLanguage === "" || primaryOf(language) !== primaryOf(originalLanguage);
}

/** Existing Content, made current: the imported translation languages that already have a current translation. */
export function replacedTranslations(preview: SubtitlePreview, choice: SubtitleImportChoice): string[] {
  const target = preview.target;
  if (target === undefined || !choice.setCurrent) return [];
  const current = new Set(Object.keys(target.currentTranslations).map((tag) => tag.toLowerCase()));
  return importedTranslationLanguages(preview, choice).filter((tag) => current.has(tag.toLowerCase()));
}

/** What keeps the import from starting; empty when it can. */
export function importBlockers(preview: SubtitlePreview, choice: SubtitleImportChoice, originalLanguage: string | undefined): ImportBlocker[] {
  const { needed, room } = speakerNeed(preview, choice);
  const unnamedTranslation = preview.bilingual !== undefined && knownTranslationLanguages(preview) === undefined;
  return [
    ...(needed > room ? (["speaker_capacity"] as const) : []),
    ...(unnamedTranslation && choice.translation === undefined ? (["translation_language"] as const) : []),
    ...(unnamedTranslation && typeof choice.translation === "string" && !translationLanguageAllowed(choice.translation, originalLanguage)
      ? (["translation_same_language"] as const)
      : []),
  ];
}

/**
 * The import `options` for a choice. Only what applies to the file is sent: SRT names and the
 * unlabeled rule for an SRT, a translation language only where the file does not name one, and
 * identities, `setCurrent` and the state the preview saw only for an existing Content.
 */
export function buildSubtitleImportOptions(preview: SubtitlePreview, choice: SubtitleImportChoice): SubtitleImportOptions {
  const prefix = preview.speakers.source === "prefix";
  const chosen = new Set(choice.prefixNames);
  const translation = preview.bilingual !== undefined && knownTranslationLanguages(preview) === undefined && typeof choice.translation === "string" ? choice.translation : undefined;
  const target = preview.target;
  const identities = effectiveIdentities(preview, choice);
  return {
    expectedDigest: preview.digest,
    ...(prefix
      ? { speakers: { prefixNames: preview.speakers.candidates.filter((candidate) => chosen.has(candidate.key)).map((candidate) => candidate.key), unlabeled: choice.unlabeled } }
      : {}),
    ...(translation === undefined ? {} : { translationLanguage: translation }),
    ...(target === undefined
      ? {}
      : {
          ...(identities.length === 0 ? {} : { identities: identities.map(({ key, speaker }) => ({ key, speakerId: speaker.id })) }),
          setCurrent: choice.setCurrent,
          expectedState: {
            primaryRevisionId: target.primaryRevisionId,
            currentTranslations: { ...target.currentTranslations },
            speakers: identities.map(({ speaker }) => ({ id: speaker.id, ...(speaker.name === undefined ? {} : { name: speaker.name }) })),
            speakerRoom: target.speakerRoom,
          },
        }),
  };
}

/** Subtitle file extensions read as reference text: imported as they are, never previewed. */
const REFERENCE_EXTENSIONS = new Set(["txt", "md", "markdown"]);

/** Whether a file name says reference text (TXT / Markdown) rather than a timed subtitle. */
export function isReferenceTextFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 && REFERENCE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

/** Preview failures a plain import would hit too: offering one would only fail again. */
const PLAIN_IMPORT_FUTILE = new Set(["invalid_request.subtitle_newer", "invalid_request.subtitle_encoding", "invalid_request.subtitle_format", "media_too_large"]);

/** Whether a failed preview may still be imported as a plain subtitle, without options. */
export function plainImportPossible(errorCode: string): boolean {
  return !PLAIN_IMPORT_FUTILE.has(errorCode);
}

/** Import failures that mean the preview is out of date: the file or the Content changed since. */
const STALE_PREVIEW_CODES = new Set([
  "conflict.subtitle_changed",
  "conflict.primary_changed",
  "conflict.translation_changed",
  "conflict.speakers_changed",
  "conflict.speaker_capacity",
]);

/** Whether an import failure asks for a fresh preview. */
export function needsFreshPreview(errorCode: string): boolean {
  return STALE_PREVIEW_CODES.has(errorCode);
}
