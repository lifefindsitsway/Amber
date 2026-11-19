import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ExportPlanContent, ExportPlanMedia } from "../../../shared/dto/content-pack.ts";
import { taskDetailDtoSchema } from "../../../shared/dto/task.ts";
import { useApi } from "../../api/context.tsx";
import { taskKindLabel } from "../../components/task-kind-label.ts";
import { requestOpenTasks } from "../../shell/task-panel.tsx";
import { Button } from "../../ui/button.tsx";
import { languageLabel } from "../content/labels.ts";
import {
  applyTemplate,
  cardHints,
  choiceSummary,
  currentTranscript,
  includeRevisions,
  transcriptsOf,
  translationsByLanguage,
  type ApplyTemplate,
  type CardHint,
  type ChoiceSummary,
  type ExportChoice,
  type TranscriptMode,
} from "./export-model.ts";
import { bytesLabel, planRevisionLabel, sourceLine, titleOf } from "./pack-labels.ts";

const TRANSCRIPT_MODES: readonly TranscriptMode[] = ["none", "current", "pick", "all"];
export const HINT_CLASS = "rounded-md bg-accent-soft px-2.5 py-1.5 text-xs";
export const DANGER_HINT_CLASS = "rounded-md border border-danger/40 bg-danger/5 px-2.5 py-1.5 text-xs";
const LEGEND_CLASS = "mb-1.5 text-xs font-medium text-muted";
const CHECK_ROW = "flex items-start gap-2 text-sm";

/** 「字幕 1 版 · 译文 1 种 · 插图 4 张 · 视频 1.2 GB」 for a collapsed card. */
export function useSummaryLine(): (summary: ChoiceSummary, content: ExportPlanContent) => string {
  const { t } = useTranslation();
  return (summary, content) => {
    const parts: string[] = [];
    parts.push(summary.transcripts > 0 ? t("contentPack.export.summary.transcripts", { count: summary.transcripts }) : t("contentPack.export.summary.noTranscript"));
    if (summary.translationLanguages > 0) parts.push(t("contentPack.export.summary.translations", { count: summary.translationLanguages }));
    if (summary.figures > 0) parts.push(t("contentPack.export.summary.figures", { count: summary.figures }));
    if (summary.notes > 0) parts.push(t("contentPack.export.summary.notes", { count: summary.notes }));
    if (summary.mediaKind !== undefined) {
      const size = bytesLabel(summary.mediaBytes);
      parts.push(t(`contentPack.export.summary.${summary.mediaKind === "mixed" ? "media" : summary.mediaKind}`, { size }));
    } else if (summary.transcripts === 0 && content.sourceKind !== "local") {
      parts.push(t("contentPack.export.summary.basicOnly"));
    }
    return parts.join(t("contentPack.separator"));
  };
}

/** The rules 「应用到全部」 carries, in words, so the user knows what will change on the other cards. */
export function useTemplateRules(): (template: ApplyTemplate) => string {
  const { t } = useTranslation();
  return (template) => {
    const rules: string[] = [];
    rules.push(template.transcriptsFromPick ? t("contentPack.export.applyAll.transcripts.currentFromPick") : t(`contentPack.export.applyAll.transcripts.${template.transcripts}`));
    if (template.translations !== "keep") rules.push(t(`contentPack.export.applyAll.translations.${template.translations}`));
    if (template.figures !== "keep") rules.push(t(`contentPack.export.applyAll.figures.${template.figures ? "on" : "off"}`));
    if (template.notes !== "keep") rules.push(t(`contentPack.export.applyAll.notes.${template.notes ? "on" : "off"}`));
    if (template.originals !== "keep") rules.push(t(`contentPack.export.applyAll.originals.${template.originals ? "on" : "off"}`));
    if (template.caches !== "keep") rules.push(t(`contentPack.export.applyAll.caches.${template.caches ? "on" : "off"}`));
    return rules.join(t("contentPack.listSeparator"));
  };
}

/** The name of the unfinished Task that keeps a Content out; unknown while it loads or when it is gone. */
function useBusyTaskName(taskId: string | undefined): string | undefined {
  const { t } = useTranslation();
  const client = useApi();
  const task = useQuery({
    queryKey: ["tasks", "detail", taskId ?? ""],
    queryFn: () => client.get(`/api/tasks/${encodeURIComponent(taskId ?? "")}`, taskDetailDtoSchema),
    enabled: taskId !== undefined,
    retry: false,
  });
  return task.data === undefined ? undefined : taskKindLabel(task.data, t);
}

/** A Content that cannot go into a pack: greyed out, with the reason right under its title. */
export function BlockedCard(props: { content: ExportPlanContent }) {
  const { t } = useTranslation();
  const { content } = props;
  const task = useBusyTaskName(content.blocked === "busy" ? content.busyTaskId : undefined);
  const title = titleOf(content.title, t);
  return (
    <section className="rounded-lg border border-line bg-panel px-3 py-2.5" data-testid="pack-export-card" data-content-id={content.contentId} data-blocked={content.blocked}>
      <h3 className="truncate text-sm font-medium text-muted" title={title}>
        {title}
      </h3>
      <p className="text-xs text-muted">{sourceLine(content.sourceKind, content.durationMs, t)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="pack-export-blocked">
        <span>
          {content.blocked === "busy"
            ? task === undefined
              ? t("contentPack.export.blocked.busyUnknown")
              : t("contentPack.export.blocked.busy", { task })
            : t("contentPack.export.blocked.nothing_to_carry")}
        </span>
        {content.blocked === "busy" ? (
          <button type="button" className="text-accent underline" onClick={requestOpenTasks}>
            {t("contentPack.export.blocked.openTasks")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One Content of the export wizard: a header button that folds the card (its summary line
 * stays visible), then three groups of choices and, where a choice leaves something behind
 * or pulls something in, a note right under it.
 */
export function ExportCard(props: {
  content: ExportPlanContent;
  choice: ExportChoice;
  onChange: (choice: ExportChoice) => void;
  expanded: boolean;
  onToggle: () => void;
  /** How many other exportable cards 「应用到全部」 would change; 0 hides it. */
  others: number;
  onApplyAll: (template: ApplyTemplate) => void;
}) {
  const { t, i18n } = useTranslation();
  const { content, choice, onChange } = props;
  const bodyId = useId();
  const applyId = useId();
  const summaryLine = useSummaryLine();
  const templateRules = useTemplateRules();
  const [applied, setApplied] = useState(false);
  const title = titleOf(content.title, t);
  const hints = cardHints(content, choice);
  const invalid = hints.some((hint) => hint.kind === "nothingToCarry");
  const transcripts = transcriptsOf(content);
  const current = currentTranscript(content);
  const translationGroups = translationsByLanguage(content);
  const archivedTranscripts = transcripts.filter((revision) => revision.archived).length;
  const label = (id: string): string => {
    const revision = content.revisions.find((item) => item.id === id);
    return revision === undefined ? "" : planRevisionLabel(revision, content.revisions, content.contentId, t, i18n);
  };
  const change = (next: ExportChoice): void => {
    setApplied(false);
    onChange(next);
  };
  const toggleIn = (list: readonly string[], id: string, on: boolean): string[] => (on ? [...list.filter((item) => item !== id), id] : list.filter((item) => item !== id));
  const hintFor = (kind: CardHint["kind"]): CardHint | undefined => hints.find((hint) => hint.kind === kind);
  const template = applyTemplate(content, choice);

  return (
    <section className="rounded-lg border border-line" data-testid="pack-export-card" data-content-id={content.contentId} data-invalid={invalid ? "true" : undefined}>
      <h3>
        <button
          type="button"
          className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent"
          aria-expanded={props.expanded}
          aria-controls={bodyId}
          onClick={props.onToggle}
          data-testid="pack-export-card-toggle"
        >
          <ChevronRight size={16} aria-hidden="true" className={`mt-0.5 shrink-0 text-muted transition-transform motion-reduce:transition-none ${props.expanded ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium" title={title}>
              {title}
            </span>
            <span className="block text-xs text-muted">
              {sourceLine(content.sourceKind, content.durationMs, t)}
              {t("contentPack.separator")}
              <span data-testid="pack-export-card-summary">{summaryLine(choiceSummary(content, choice), content)}</span>
            </span>
          </span>
          {invalid ? <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-xs whitespace-nowrap text-danger">{t("contentPack.export.invalidBadge")}</span> : null}
        </button>
      </h3>
      {props.expanded ? (
        <div id={bodyId} className="flex flex-col gap-4 border-t border-line px-3 py-3" data-testid="pack-export-card-body">
          <p className="text-xs text-muted">
            {t(content.sourceKind === "local" ? "contentPack.export.basics.local" : content.platformChapters ? "contentPack.export.basics.platformChapters" : "contentPack.export.basics.platform")}
            {content.speakers > 0 ? t("contentPack.export.basics.speakers") : ""}
          </p>

          <fieldset className="min-w-0">
            <legend className={LEGEND_CLASS}>{t("contentPack.export.group.transcripts")}</legend>
            {transcripts.length === 0 ? (
              <p className="text-sm text-muted">{t("contentPack.export.noTranscriptHere")}</p>
            ) : (
              <div role="radiogroup" aria-label={t("contentPack.export.transcriptMode.label")} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="text-sm" aria-hidden="true">
                  {t("contentPack.export.transcriptMode.label")}
                </span>
                {TRANSCRIPT_MODES.map((mode) => (
                  <label key={mode} className="inline-flex items-center gap-1.5">
                    <input
                      type="radio"
                      name={`${bodyId}-transcripts`}
                      value={mode}
                      checked={choice.transcripts === mode}
                      disabled={mode === "current" && current === undefined}
                      onChange={() =>
                        change({
                          ...choice,
                          transcripts: mode,
                          // Picking starts from what was carried, so switching modes never drops a version silently.
                          picked: mode === "pick" ? (choice.transcripts === "pick" ? choice.picked : seedPick(content, choice)) : [],
                        })
                      }
                      data-testid={`pack-transcripts-${mode}`}
                    />
                    {t(`contentPack.export.transcriptMode.${mode}`)}
                  </label>
                ))}
              </div>
            )}
            {choice.transcripts === "current" && current !== undefined ? (
              <p className="mt-1 text-xs text-muted" data-testid="pack-transcripts-current-label">
                {label(current.id)}
              </p>
            ) : null}
            {choice.transcripts === "all" && archivedTranscripts > 0 ? <p className="mt-1 text-xs text-muted">{t("contentPack.export.allIncludesArchived", { count: archivedTranscripts })}</p> : null}
            {choice.transcripts === "pick" ? (
              <ul className="mt-2 flex flex-col gap-1 pl-1" data-testid="pack-transcripts-picked">
                {transcripts.map((revision) => (
                  <li key={revision.id}>
                    <label className={CHECK_ROW}>
                      <input type="checkbox" className="mt-1" checked={choice.picked.includes(revision.id)} onChange={(event) => change({ ...choice, picked: toggleIn(choice.picked, revision.id, event.target.checked) })} />
                      <span className="min-w-0 break-words">{label(revision.id)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3">
              <p className="mb-1 text-sm">{t("contentPack.export.translations")}</p>
              {translationGroups.length === 0 ? (
                <p className="text-xs text-muted">{t("contentPack.export.noTranslations")}</p>
              ) : (
                <div className="flex flex-col gap-2 pl-1">
                  {translationGroups.map((group) => (
                    <div key={group.language} role="group" aria-label={languageLabel(group.language, t, i18n)}>
                      <p className="text-xs text-muted" aria-hidden="true">
                        {languageLabel(group.language, t, i18n)}
                      </p>
                      <ul className="flex flex-col gap-1">
                        {group.revisions.map((revision) => (
                          <li key={revision.id}>
                            <label className={CHECK_ROW}>
                              <input
                                type="checkbox"
                                className="mt-1"
                                checked={choice.translations.includes(revision.id)}
                                onChange={(event) => change({ ...choice, translations: toggleIn(choice.translations, revision.id, event.target.checked) })}
                                data-testid="pack-translation"
                              />
                              <span className="min-w-0 break-words">
                                {label(revision.id)}
                                {revision.currentTranslation ? <span className="ml-1.5 rounded bg-sunken px-1 py-0.5 text-xs text-muted">{t("contentPack.export.currentTag")}</span> : null}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <RevisionHints hint={hintFor("translationParents")} label={label} />
            <RevisionHints hint={hintFor("standalone")} label={label} />
            {hintFor("noTranscript") === undefined ? null : (
              <p className={`mt-2 ${HINT_CLASS}`} data-testid="pack-hint-no-transcript">
                {t("contentPack.export.hint.noTranscript")}
              </p>
            )}
            {invalid ? (
              <p className={`mt-2 ${DANGER_HINT_CLASS}`} role="alert" data-testid="pack-hint-nothing">
                {t("contentPack.export.hint.nothingToCarry")}
              </p>
            ) : null}
          </fieldset>

          <fieldset className="min-w-0">
            <legend className={LEGEND_CLASS}>{t("contentPack.export.group.personal")}</legend>
            <div className="flex flex-col gap-1.5">
              <label className={CHECK_ROW}>
                <input type="checkbox" className="mt-1" checked={choice.figures && content.figures > 0} disabled={content.figures === 0} onChange={(event) => change({ ...choice, figures: event.target.checked })} data-testid="pack-figures" />
                <span className={content.figures === 0 ? "text-muted" : ""}>{content.figures === 0 ? t("contentPack.export.noFigures") : t("contentPack.export.figuresCount", { count: content.figures })}</span>
              </label>
              <CountHint hint={hintFor("figuresOnUnselected")} onInclude={(ids) => change(includeRevisions(content, choice, ids))} />
              <label className={CHECK_ROW}>
                <input type="checkbox" className="mt-1" checked={choice.notes && content.notes > 0} disabled={content.notes === 0} onChange={(event) => change({ ...choice, notes: event.target.checked })} data-testid="pack-notes" />
                <span className={content.notes === 0 ? "text-muted" : ""}>{content.notes === 0 ? t("contentPack.export.noNotes") : t("contentPack.export.notesCount", { count: content.notes })}</span>
              </label>
              <CountHint hint={hintFor("notesOnUnselected")} onInclude={(ids) => change(includeRevisions(content, choice, ids))} />
            </div>
          </fieldset>

          <fieldset className="min-w-0">
            <legend className={LEGEND_CLASS}>{t("contentPack.export.group.media")}</legend>
            {content.media.length === 0 ? (
              <p className="text-sm text-muted">{t("contentPack.export.noMedia")}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {content.media.map((media) => (
                  <li key={media.assetId}>
                    <MediaRow media={media} checked={choice.media.includes(media.assetId)} onChange={(on) => change({ ...choice, media: toggleIn(choice.media, media.assetId, on) })} />
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          {props.others > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3">
              <Button
                size="sm"
                aria-describedby={applyId}
                onClick={() => {
                  props.onApplyAll(template);
                  setApplied(true);
                }}
                data-testid="pack-apply-all"
              >
                {t("contentPack.export.applyAll.action")}
              </Button>
              <p id={applyId} className="min-w-0 flex-1 text-xs text-muted">
                {t("contentPack.export.applyAll.description", { count: props.others, rules: templateRules(template) })}
              </p>
              {applied ? (
                <span role="status" className="text-xs text-ok">
                  {t("contentPack.export.applyAll.done")}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The transcripts a hand-picked set starts from: those carried a moment ago, the current one at least. */
function seedPick(content: ExportPlanContent, choice: ExportChoice): string[] {
  if (choice.transcripts === "all") return transcriptsOf(content).map((revision) => revision.id);
  const current = currentTranscript(content);
  return choice.transcripts === "current" && current !== undefined ? [current.id] : [];
}

function RevisionHints(props: { hint: CardHint | undefined; label: (id: string) => string }) {
  const { t } = useTranslation();
  const { hint } = props;
  if (hint === undefined || (hint.kind !== "translationParents" && hint.kind !== "standalone")) return null;
  const labels = hint.revisionIds.map((id) => t("contentPack.quoted", { text: props.label(id) })).join(t("contentPack.listSeparator"));
  return (
    <p className={`mt-2 ${HINT_CLASS}`} data-testid={`pack-hint-${hint.kind}`}>
      {t(hint.kind === "translationParents" ? "contentPack.export.hint.translationParents" : "contentPack.export.hint.standalone", { labels })}
    </p>
  );
}

function CountHint(props: { hint: CardHint | undefined; onInclude: (revisionIds: string[]) => void }) {
  const { t } = useTranslation();
  const { hint } = props;
  if (hint === undefined || (hint.kind !== "notesOnUnselected" && hint.kind !== "figuresOnUnselected")) return null;
  return (
    <div className={`ml-6 flex flex-wrap items-center gap-x-3 gap-y-1 ${HINT_CLASS}`} data-testid={`pack-hint-${hint.kind}`}>
      <span>{t(`contentPack.export.hint.${hint.kind}`, { count: hint.count })}</span>
      <button type="button" className="font-medium text-accent underline" onClick={() => props.onInclude(hint.revisionIds)}>
        {t("contentPack.export.hint.includeVersions")}
      </button>
    </div>
  );
}

function MediaRow(props: { media: ExportPlanMedia; checked: boolean; onChange: (on: boolean) => void }) {
  const { t } = useTranslation();
  const { media } = props;
  const unavailable = media.unavailable;
  const name: ReactNode = (
    <>
      {t(`contentPack.export.mediaKind.${media.kind}`)}
      {media.quality === undefined ? null : `${t("contentPack.separator")}${media.quality}`}
      {media.displayName === undefined ? null : (
        <>
          {t("contentPack.separator")}
          <span className="break-all">{media.displayName}</span>
        </>
      )}
    </>
  );
  return (
    <label className={`${CHECK_ROW} ${unavailable === undefined ? "" : "cursor-not-allowed"}`} data-testid="pack-media" data-asset-id={media.assetId}>
      <input type="checkbox" className="mt-1" checked={props.checked && unavailable === undefined} disabled={unavailable !== undefined} onChange={(event) => props.onChange(event.target.checked)} />
      <span className="min-w-0">
        <span className={unavailable === undefined ? "" : "text-muted"}>{name}</span>
        <span className="ml-2 font-mono text-xs text-muted">{bytesLabel(media.sizeBytes)}</span>
        {unavailable === undefined ? null : <span className="block text-xs text-muted">{t(`contentPack.export.mediaUnavailable.${unavailable}`)}</span>}
      </span>
    </label>
  );
}
