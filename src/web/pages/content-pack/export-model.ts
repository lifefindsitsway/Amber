import type {
  ContentPackExportPlanDto,
  ContentPackSelection,
  ExportPlanCollection,
  ExportPlanContent,
  ExportPlanMedia,
  ExportPlanRevision,
} from "../../../shared/dto/content-pack.ts";

/**
 * The export wizard's choices and the rules between them, free of React so they can be
 * tested on their own. A choice names revisions, files and switches of one Content; every
 * dependency (a translation's original, notes and figures on revisions left behind, a
 * corrected revision without its parent) is derived from it, never stored.
 */

/** Which transcripts (every revision but translations) go: none, the current one, a hand-picked set, all of them. */
export type TranscriptMode = "none" | "current" | "pick" | "all";

export interface ExportChoice {
  transcripts: TranscriptMode;
  /** The transcripts ticked while `transcripts` is `pick`. */
  picked: readonly string[];
  /** The translations ticked, by revision. */
  translations: readonly string[];
  figures: boolean;
  notes: boolean;
  /** Media assets to carry; only files that can be carried. */
  media: readonly string[];
}

export function isTranslation(revision: Pick<ExportPlanRevision, "kind">): boolean {
  return revision.kind === "translated";
}

/** The transcripts of a Content in creation order. */
export function transcriptsOf(content: ExportPlanContent): ExportPlanRevision[] {
  return content.revisions.filter((revision) => !isTranslation(revision)).sort((a, b) => a.createdAt - b.createdAt);
}

/** The translations of a Content grouped by language, each group oldest first; languages in first-seen order. */
export function translationsByLanguage(content: ExportPlanContent): Array<{ language: string; revisions: ExportPlanRevision[] }> {
  const groups = new Map<string, ExportPlanRevision[]>();
  for (const revision of [...content.revisions].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!isTranslation(revision)) continue;
    const group = groups.get(revision.language) ?? [];
    group.push(revision);
    groups.set(revision.language, group);
  }
  return [...groups].map(([language, revisions]) => ({ language, revisions }));
}

/** The Content's current transcript, if it has one. */
export function currentTranscript(content: ExportPlanContent): ExportPlanRevision | undefined {
  return content.revisions.find((revision) => revision.primary && !isTranslation(revision));
}

/** Media files that can go into a pack. */
export function carryableMedia(content: ExportPlanContent): ExportPlanMedia[] {
  return content.media.filter((media) => media.unavailable === undefined);
}

/** Each language's current translation that is not archived. */
function currentTranslations(content: ExportPlanContent): string[] {
  return content.revisions.filter((revision) => isTranslation(revision) && revision.currentTranslation && !revision.archived).map((revision) => revision.id);
}

/**
 * Where a card starts: the current transcript, every language's current translation, figures
 * on and notes off, and the original files (platform caches can be fetched again, so they
 * start off, as in a full backup).
 */
export function defaultChoice(content: ExportPlanContent): ExportChoice {
  return {
    transcripts: currentTranscript(content) === undefined ? "none" : "current",
    picked: [],
    translations: currentTranslations(content),
    figures: true,
    notes: false,
    media: carryableMedia(content)
      .filter((media) => media.kind === "original")
      .map((media) => media.assetId),
  };
}

export interface RevisionSelection {
  /** Every revision that goes, in the plan's order. */
  ids: string[];
  /** Transcripts that go only because a ticked translation needs them. */
  autoParents: string[];
}

/** The revisions a choice carries: the transcripts its mode names, the ticked translations and their originals. */
export function selectedRevisions(content: ExportPlanContent, choice: ExportChoice): RevisionSelection {
  const known = new Map(content.revisions.map((revision) => [revision.id, revision]));
  const transcripts = new Set<string>();
  if (choice.transcripts === "current") {
    const current = currentTranscript(content);
    if (current !== undefined) transcripts.add(current.id);
  } else if (choice.transcripts === "all") {
    for (const revision of transcriptsOf(content)) transcripts.add(revision.id);
  } else if (choice.transcripts === "pick") {
    for (const id of choice.picked) {
      const revision = known.get(id);
      if (revision !== undefined && !isTranslation(revision)) transcripts.add(id);
    }
  }
  const translations = choice.translations.filter((id) => {
    const revision = known.get(id);
    return revision !== undefined && isTranslation(revision);
  });
  const autoParents: string[] = [];
  for (const id of translations) {
    const parent = known.get(id)?.parentRevisionId;
    if (parent !== undefined && known.has(parent) && !transcripts.has(parent) && !autoParents.includes(parent)) autoParents.push(parent);
  }
  const all = new Set([...transcripts, ...translations, ...autoParents]);
  return { ids: content.revisions.filter((revision) => all.has(revision.id)).map((revision) => revision.id), autoParents };
}

export type CardHint =
  | { kind: "translationParents"; revisionIds: string[] }
  | { kind: "notesOnUnselected"; count: number; revisionIds: string[] }
  | { kind: "figuresOnUnselected"; count: number; revisionIds: string[] }
  | { kind: "standalone"; revisionIds: string[] }
  | { kind: "noTranscript" }
  | { kind: "nothingToCarry" };

/**
 * The dependencies and warnings of one card, in the order the card shows them. Notes and
 * figures on revisions left behind are only mentioned while their category is ticked.
 * `nothingToCarry` makes the card invalid: a local Content needs a transcript or a file.
 */
export function cardHints(content: ExportPlanContent, choice: ExportChoice): CardHint[] {
  const { ids, autoParents } = selectedRevisions(content, choice);
  const selected = new Set(ids);
  const hints: CardHint[] = [];
  if (autoParents.length > 0) hints.push({ kind: "translationParents", revisionIds: autoParents });
  const unselected = content.revisions.filter((revision) => !selected.has(revision.id));
  if (choice.notes) {
    const holding = unselected.filter((revision) => revision.notes > 0);
    const count = holding.reduce((sum, revision) => sum + revision.notes, 0);
    if (count > 0) hints.push({ kind: "notesOnUnselected", count, revisionIds: holding.map((revision) => revision.id) });
  }
  if (choice.figures) {
    const holding = unselected.filter((revision) => revision.anchoredFigures > 0);
    const count = holding.reduce((sum, revision) => sum + revision.anchoredFigures, 0);
    if (count > 0) hints.push({ kind: "figuresOnUnselected", count, revisionIds: holding.map((revision) => revision.id) });
  }
  const standalone = content.revisions.filter(
    (revision) => selected.has(revision.id) && !isTranslation(revision) && revision.parentRevisionId !== undefined && !selected.has(revision.parentRevisionId),
  );
  if (standalone.length > 0) hints.push({ kind: "standalone", revisionIds: standalone.map((revision) => revision.id) });
  const transcriptCarried = content.revisions.some((revision) => selected.has(revision.id) && !isTranslation(revision));
  if (!transcriptCarried) {
    const nothing = content.sourceKind === "local" && choice.media.length === 0;
    hints.push(nothing ? { kind: "nothingToCarry" } : { kind: "noTranscript" });
  }
  return hints;
}

/** Whether a choice leaves the Content something usable on the other device. */
export function choiceValid(content: ExportPlanContent, choice: ExportChoice): boolean {
  return !cardHints(content, choice).some((hint) => hint.kind === "nothingToCarry");
}

/**
 * Adds revisions to a choice (「一并带上这些版本」): transcripts switch the mode to a hand-picked
 * set holding what was carried before plus them; translations are ticked.
 */
export function includeRevisions(content: ExportPlanContent, choice: ExportChoice, revisionIds: readonly string[]): ExportChoice {
  const known = new Map(content.revisions.map((revision) => [revision.id, revision]));
  const adding = revisionIds.map((id) => known.get(id)).filter((revision): revision is ExportPlanRevision => revision !== undefined);
  const translations = new Set(choice.translations);
  for (const revision of adding) if (isTranslation(revision)) translations.add(revision.id);
  const transcripts = adding.filter((revision) => !isTranslation(revision)).map((revision) => revision.id);
  const next: ExportChoice = { ...choice, translations: content.revisions.filter((revision) => translations.has(revision.id)).map((revision) => revision.id) };
  if (transcripts.length === 0) return next;
  const carried = selectedRevisions(content, choice).ids.filter((id) => !isTranslation(known.get(id) as ExportPlanRevision));
  const picked = new Set([...carried, ...transcripts]);
  // Everything picked again is just "all"; keep the simpler mode then.
  const everyTranscript = transcriptsOf(content).every((revision) => picked.has(revision.id));
  return everyTranscript ? { ...next, transcripts: "all", picked: [] } : { ...next, transcripts: "pick", picked: content.revisions.filter((revision) => picked.has(revision.id)).map((revision) => revision.id) };
}

export interface ChoiceSummary {
  transcripts: number;
  translationLanguages: number;
  figures: number;
  notes: number;
  mediaBytes: number;
  /** What the carried files are, for 「视频 1.2 GB」 / 「音频 …」 / 「音视频 …」. */
  mediaKind: "video" | "audio" | "mixed" | undefined;
}

/** The one-line summary of a collapsed card. */
export function choiceSummary(content: ExportPlanContent, choice: ExportChoice): ChoiceSummary {
  const ids = new Set(selectedRevisions(content, choice).ids);
  const carried = content.revisions.filter((revision) => ids.has(revision.id));
  const media = content.media.filter((item) => choice.media.includes(item.assetId));
  const kinds = new Set(media.map((item) => (item.mimeType.startsWith("audio/") ? "audio" : "video")));
  return {
    transcripts: carried.filter((revision) => !isTranslation(revision)).length,
    translationLanguages: new Set(carried.filter(isTranslation).map((revision) => revision.language)).size,
    figures: choice.figures ? content.figures : 0,
    notes: choice.notes ? carried.reduce((sum, revision) => sum + revision.notes, 0) : 0,
    mediaBytes: media.reduce((sum, item) => sum + item.sizeBytes, 0),
    mediaKind: kinds.size === 0 ? undefined : kinds.size > 1 ? "mixed" : (([...kinds][0] as "audio" | "video") ?? "video"),
  };
}

/**
 * The parts of one card's choice that 「应用到全部」 carries to the others, as rules that make
 * sense for any Content. A hand-picked set of transcripts names revisions of this Content
 * only, so it goes as 「当前版本」; `keep` leaves a part alone because this card cannot say
 * anything about it (it has no translations, no figures, no files of that kind).
 */
export interface ApplyTemplate {
  transcripts: "none" | "current" | "all";
  transcriptsFromPick: boolean;
  translations: "none" | "current" | "all" | "keep";
  figures: boolean | "keep";
  notes: boolean | "keep";
  originals: boolean | "keep";
  caches: boolean | "keep";
}

export function applyTemplate(content: ExportPlanContent, choice: ExportChoice): ApplyTemplate {
  const translations = content.revisions.filter(isTranslation);
  const ticked = new Set(choice.translations);
  const carryable = carryableMedia(content);
  const originals = carryable.filter((media) => media.kind === "original");
  const caches = carryable.filter((media) => media.kind === "cache");
  return {
    transcripts: choice.transcripts === "pick" ? "current" : choice.transcripts,
    transcriptsFromPick: choice.transcripts === "pick",
    translations:
      translations.length === 0
        ? "keep"
        : ticked.size === 0
          ? "none"
          : translations.every((revision) => ticked.has(revision.id))
            ? "all"
            : "current",
    figures: content.figures === 0 ? "keep" : choice.figures,
    notes: content.notes === 0 ? "keep" : choice.notes,
    originals: originals.length === 0 ? "keep" : originals.some((media) => choice.media.includes(media.assetId)),
    caches: caches.length === 0 ? "keep" : caches.some((media) => choice.media.includes(media.assetId)),
  };
}

/** One card's choice with a template applied. */
export function applyToContent(content: ExportPlanContent, choice: ExportChoice, template: ApplyTemplate): ExportChoice {
  const transcripts: TranscriptMode = template.transcripts === "current" && currentTranscript(content) === undefined ? "none" : template.transcripts;
  const all = content.revisions.filter(isTranslation).map((revision) => revision.id);
  const translations =
    template.translations === "keep" ? choice.translations : template.translations === "none" ? [] : template.translations === "all" ? all : currentTranslations(content);
  const carryable = carryableMedia(content);
  const pick = (kind: ExportPlanMedia["kind"], rule: boolean | "keep"): string[] => {
    const ofKind = carryable.filter((media) => media.kind === kind).map((media) => media.assetId);
    if (rule === "keep") return choice.media.filter((id) => ofKind.includes(id));
    return rule ? ofKind : [];
  };
  return {
    transcripts,
    picked: [],
    translations,
    figures: template.figures === "keep" ? choice.figures : template.figures,
    notes: template.notes === "keep" ? choice.notes : template.notes,
    media: [...pick("original", template.originals), ...pick("cache", template.caches)],
  };
}

/** The Contents a pack can carry: everything not blocked. */
export function exportableContents(plan: ContentPackExportPlanDto): ExportPlanContent[] {
  return plan.contents.filter((content) => content.blocked === undefined);
}

/** How many of a collection's planned members go into the pack. */
export function carriedMembers(collection: ExportPlanCollection, exportable: ReadonlySet<string>): number {
  return collection.contentIds.filter((id) => exportable.has(id)).length;
}

/**
 * The export request: every exportable Content with its revisions (translations' originals
 * included), files and switches, and the ticked collections that still carry a member.
 */
export function buildSelection(plan: ContentPackExportPlanDto, choices: ReadonlyMap<string, ExportChoice>, collectionIds: ReadonlySet<string>): ContentPackSelection {
  const contents = exportableContents(plan).map((content) => {
    const choice = choices.get(content.contentId) ?? defaultChoice(content);
    return {
      contentId: content.contentId,
      revisionIds: selectedRevisions(content, choice).ids,
      figures: choice.figures,
      notes: choice.notes,
      mediaAssetIds: carryableMedia(content)
        .filter((media) => choice.media.includes(media.assetId))
        .map((media) => media.assetId),
    };
  });
  const exportable = new Set(contents.map((content) => content.contentId));
  return {
    contents,
    collectionIds: plan.collections.filter((collection) => collectionIds.has(collection.collectionId) && carriedMembers(collection, exportable) > 0).map((collection) => collection.collectionId),
  };
}

/** The registered size of everything chosen; the pack adds its documents on top. */
export function totalBytes(plan: ContentPackExportPlanDto, choices: ReadonlyMap<string, ExportChoice>): number {
  return exportableContents(plan).reduce((sum, content) => sum + choiceSummary(content, choices.get(content.contentId) ?? defaultChoice(content)).mediaBytes, 0);
}

/** Characters no file system accepts in a name, and controls. */
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;

/**
 * The name offered in the save dialog: the single Content's title or the collection's
 * name, else 「Amber 内容包」, then the local time; the shell adds nothing.
 */
export function suggestedPackName(input: { titles: readonly (string | undefined)[]; collectionName?: string | undefined; fallback: string; stamp: string; extension: string }): string {
  const only = input.titles.length === 1 ? input.titles[0] : undefined;
  const base = (input.collectionName ?? only ?? input.fallback).replace(UNSAFE_NAME, " ").replace(/\s+/gu, " ").trim();
  const short = [...(base === "" ? input.fallback : base)].slice(0, 60).join("").trim();
  return `${short} ${input.stamp}.${input.extension}`;
}
