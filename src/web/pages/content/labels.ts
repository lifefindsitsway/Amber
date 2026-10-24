import type { i18n as I18n, TFunction } from "i18next";
import type { TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import type { SummaryTemplateDto } from "../../../shared/dto/summary.ts";
import type { zhCN } from "../../../shared/i18n/zh-CN/index.ts";

type TemplateNameKey = `summaryTemplate.${keyof typeof zhCN.summaryTemplate}`;

/** A builtin template's `name` is an i18n key; a custom one is the user's own text. */
export function templateName(template: SummaryTemplateDto, t: TFunction): string {
  return template.builtin ? t(template.name as TemplateNameKey) : template.name;
}

/** A language's display name by full tag, then primary subtag; an unlisted tag as it is. */
export function languageLabel(tag: string, t: TFunction, i18n: Pick<I18n, "exists">): string {
  if (i18n.exists(`languageNames.${tag}`)) return t(`languageNames.${tag}` as "languageNames.en");
  const primary = tag.split("-")[0] ?? tag;
  return i18n.exists(`languageNames.${primary}`) ? t(`languageNames.${primary}` as "languageNames.en") : tag;
}

/**
 * The model a revision was produced by: the display snapshot of a proofread or translated
 * revision (kept after its Profile is gone), or an ASR revision's model id.
 */
function revisionModel(revision: TranscriptRevisionDto): string | undefined {
  const generation = revision.generation;
  if (generation["kind"] === "asr") {
    return filled(generation["modelId"]);
  }
  if (generation["kind"] !== "llm") return undefined;
  const modelRef = generation["modelRef"];
  if (typeof modelRef !== "object" || modelRef === null) return undefined;
  const { modelDisplaySnapshot, modelId } = modelRef as Record<string, unknown>;
  return filled(modelDisplaySnapshot) ?? filled(modelId);
}

/** The value when it is a non-empty string. */
function filled(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** `MM-DD HH:mm` in local time, as revision labels show it. */
export function revisionTimeLabel(epochMs: number): string {
  return revisionTime(epochMs, false);
}

/** `MM-DD HH:mm` in local time, with `:ss` when two revisions would otherwise read the same. */
function revisionTime(epochMs: number, seconds: boolean): string {
  const date = new Date(epochMs);
  const time = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return seconds ? `${time}:${pad(date.getSeconds())}` : time;
}

function baseLabel(revision: TranscriptRevisionDto, t: TFunction, i18n: Pick<I18n, "exists"> | undefined, seconds: boolean): string {
  const parts: string[] = [t(`contentView.revisionKind.${revision.kind}`)];
  // Every other kind is in the Content's own language; a translation is named by its target.
  if (revision.kind === "translated") {
    parts.push(i18n === undefined ? revision.language : languageLabel(revision.language, t, i18n));
  }
  const model = revisionModel(revision);
  if (model !== undefined) parts.push(model);
  parts.push(revisionTime(revision.createdAt, seconds));
  return parts.join(" · ");
}

/**
 * "校对稿 · deepseek-flash · 10-04 11:50" style label: kind, a translation's language, the
 * model that produced it and when, so several proofreads of one Content tell apart without
 * numbering. Given the revisions listed beside it, the time gains seconds where two labels
 * would collide. The primary revision is marked as the current one, an archived one as such.
 */
export function revisionLabel(
  revision: TranscriptRevisionDto & { archived?: boolean },
  primaryId: string | undefined,
  t: TFunction,
  i18n?: Pick<I18n, "exists">,
  among: readonly TranscriptRevisionDto[] = [],
): string {
  const label = baseLabel(revision, t, i18n, false);
  const collides = among.some((other) => other.id !== revision.id && baseLabel(other, t, i18n, false) === label);
  const base = collides ? baseLabel(revision, t, i18n, true) : label;
  const tagged = revision.archived === true ? t("contentView.revisions.archivedTag", { label: base }) : base;
  return revision.id === primaryId ? t("contentView.revision.current", { label: tagged }) : tagged;
}

/** "基于：…" naming the revision this one was made from, when it is among the listed ones. */
export function revisionBasis(revision: TranscriptRevisionDto, among: readonly TranscriptRevisionDto[], t: TFunction, i18n?: Pick<I18n, "exists">): string | undefined {
  const parent = revision.parentRevisionId === undefined ? undefined : among.find((other) => other.id === revision.parentRevisionId);
  return parent === undefined ? undefined : t("contentView.revision.basedOn", { label: revisionLabel(parent, undefined, t, i18n, among) });
}
