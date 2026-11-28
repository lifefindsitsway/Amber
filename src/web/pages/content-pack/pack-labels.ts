import type { i18n as I18n, TFunction } from "i18next";
import type { TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import type { ExportPlanRevision, PackRevisionDiff } from "../../../shared/dto/content-pack.ts";
import type { ContentSourceKind } from "../../../shared/enums.ts";
import { formatBytes } from "../../../shared/units.ts";
import { formatDuration } from "../../format.ts";
import { revisionLabel } from "../content/labels.ts";

/** An export plan revision as the revision labels read it. */
export function planRevisionDto(revision: ExportPlanRevision, contentId: string): TranscriptRevisionDto & { archived: boolean } {
  return {
    id: revision.id,
    contentId,
    kind: revision.kind,
    ...(revision.parentRevisionId === undefined ? {} : { parentRevisionId: revision.parentRevisionId }),
    language: revision.language,
    timingFidelity: revision.timingFidelity,
    generation: revision.generation,
    segmentCount: revision.segmentCount,
    createdAt: revision.createdAt,
    archived: revision.archived,
  };
}

/** The label a plan revision has in every version picker of the Content, the current one marked. */
export function planRevisionLabel(revision: ExportPlanRevision, all: readonly ExportPlanRevision[], contentId: string, t: TFunction, i18n: Pick<I18n, "exists">): string {
  const dtos = all.map((item) => planRevisionDto(item, contentId));
  const primary = all.find((item) => item.primary && item.kind !== "translated")?.id;
  return revisionLabel(planRevisionDto(revision, contentId), primary, t, i18n, dtos);
}

/**
 * A carried revision labelled the way it will read once imported: a standalone one names
 * what it was (「导入自内容包 · 原为校对稿」), others their kind, a translation its language,
 * then the model and the time.
 */
export function packRevisionLabel(revision: PackRevisionDiff, t: TFunction, i18n: Pick<I18n, "exists">): string {
  const dto: TranscriptRevisionDto & { archived: boolean } = {
    id: revision.key,
    contentId: "",
    kind: revision.kind,
    language: revision.language,
    timingFidelity: "segment_only",
    generation: { kind: "pack", originalKind: revision.originalKind, ...(revision.modelName === undefined ? {} : { modelName: revision.modelName }) },
    segmentCount: revision.segmentCount,
    createdAt: revision.createdAt,
    archived: revision.archived,
  };
  return revisionLabel(dto, undefined, t, i18n);
}

/** 「B 站 · 12:30」: where a Content comes from and how long it is. */
export function sourceLine(sourceKind: ContentSourceKind, durationMs: number | undefined, t: TFunction): string {
  const source = t(`contentPack.source.${sourceKind}`);
  return durationMs === undefined ? source : `${source}${t("contentPack.separator")}${formatDuration(durationMs)}`;
}

export function bytesLabel(bytes: number): string {
  return formatBytes(bytes);
}

/** Titles of Contents that have none read 「未命名内容」. */
export function titleOf(title: string | undefined, t: TFunction): string {
  return title === undefined || title.trim() === "" ? t("contentPack.untitled") : title;
}

/**
 * A title or collection name as a sentence cites it: in quotes, unless the text already opens
 * and closes with the title marks (common on some platforms), in which case those are the only
 * brackets shown. The text itself is never rewritten.
 */
export function quotedTitle(text: string, t: TFunction): string {
  const open = t("contentPack.titleMarks.open");
  const close = t("contentPack.titleMarks.close");
  const marked = text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close);
  return marked ? text : t("contentPack.quoted", { text });
}

/**
 * A local revision the preview describes only by kind, language, time and model, named as
 * the revision list names it (「校对稿 · deepseek-flash · 11-18 10:02」).
 */
export function describedRevisionLabel(
  revision: { kind: TranscriptRevisionDto["kind"]; language: string; createdAt: number; modelName?: string | undefined },
  t: TFunction,
  i18n: Pick<I18n, "exists">,
): string {
  const dto: TranscriptRevisionDto = {
    id: "",
    contentId: "",
    kind: revision.kind,
    language: revision.language,
    timingFidelity: "segment_only",
    // The model name is all the preview keeps; a pack-shaped generation is how labels read a bare name.
    generation: { kind: "pack", originalKind: revision.kind, ...(revision.modelName === undefined ? {} : { modelName: revision.modelName }) },
    segmentCount: 0,
    createdAt: revision.createdAt,
  };
  return revisionLabel(dto, undefined, t, i18n);
}
