import { useMutation } from "@tanstack/react-query";
import { Copy, Download } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import { SPEAKER_LABEL_MODES, type SpeakerLabelMode } from "../../../shared/speakers.ts";
import { BILINGUAL_EXPORT_FORMATS, SUBTITLE_EXPORT_FORMATS, type ContentExportRequest, type MarkdownExportRequest, type SubtitleExportFormat, type SubtitleExportRequest } from "../../../shared/dto/export.ts";
import { ApiError } from "../../api/client.ts";
import { useMe } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { useContentExport } from "../../export/export-data.ts";
import { upgradeTrackPref, useSubtitlePrefs } from "../../player/subtitle-prefs.ts";
import { exportSaver } from "../../export/export-saver.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { useContentPage } from "./content-context.tsx";
import { pickTranslation, rootsOf, translationCurrents, useChapters, useRevisions, useSegments, useSummaries, useTranslations, visibleRevisions } from "./content-data.ts";
import { revisionLabel, templateName } from "./labels.ts";

/** What the left side of the dialog has ticked. */
export interface MarkdownChoice {
  summaryTemplateId: string | undefined;
  chapters: boolean;
  transcriptRevisionId: string | undefined;
  subtitlesRevisionId: string | undefined;
  backlinks: boolean;
  /** Name the speakers in the transcript section; only meaningful while that section is ticked. */
  includeSpeakers?: boolean;
}

/** The Markdown export request: only ticked sections, each naming its revision. */
export function markdownExportBody(choice: MarkdownChoice): MarkdownExportRequest {
  return {
    format: "markdown",
    sections: {
      ...(choice.summaryTemplateId === undefined ? {} : { summary: { templateId: choice.summaryTemplateId } }),
      ...(choice.chapters ? { chapters: true } : {}),
      ...(choice.transcriptRevisionId === undefined ? {} : { transcript: { revisionId: choice.transcriptRevisionId } }),
      ...(choice.subtitlesRevisionId === undefined ? {} : { subtitles: { revisionId: choice.subtitlesRevisionId } }),
    },
    backlinks: choice.backlinks,
    ...(choice.includeSpeakers === true && choice.transcriptRevisionId !== undefined ? { includeSpeakers: true } : {}),
  };
}

/** Subtitle formats whose speaker names go on the first line of each turn or on every line, as the user chooses. */
const SPEAKER_LABELED_FORMATS: ReadonlySet<SubtitleExportFormat> = new Set(["srt", "srt-bilingual", "txt"]);

/** Speakers in a subtitle file: how SRT and TXT mark them (the other formats name the speaker on every cue). */
export interface SubtitleSpeakerChoice {
  labels: SpeakerLabelMode;
}

/** A subtitle-file export request; the bilingual formats pair the revision with its translation. */
export function subtitleExportBody(
  format: SubtitleExportFormat,
  revisionId: string,
  translationRevisionId: string | undefined,
  speakers?: SubtitleSpeakerChoice,
): SubtitleExportRequest {
  const base: SubtitleExportRequest =
    BILINGUAL_EXPORT_FORMATS.has(format) && translationRevisionId !== undefined ? { format, revisionId, translationRevisionId } : { format, revisionId };
  if (speakers === undefined) return base;
  return { ...base, includeSpeakers: true, ...(SPEAKER_LABELED_FORMATS.has(format) ? { speakerLabels: speakers.labels } : {}) };
}

/**
 * The translations a bilingual export of `revisionId` may pair with: those whose parent it is.
 * Archived ones stay out, as in every version picker, so no default falls back to them.
 */
export function translationsOf(revisionId: string | undefined, revisions: ReadonlyArray<TranscriptRevisionDto & { archived?: boolean }>): TranscriptRevisionDto[] {
  return revisions.filter((revision) => revision.kind === "translated" && revision.parentRevisionId === revisionId && revision.archived !== true);
}

/**
 * The export dialog: sections and back-links on the left; copy, Markdown and
 * subtitle files on the right. Every request names its revisions; files are saved through
 * the export saver.
 */
export function ExportDialog(props: { open: boolean; onClose: () => void; templateId?: string }) {
  const { t } = useTranslation();
  return (
    <Modal open={props.open} onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("contentView.export.title")} wide>
      {props.open ? <ExportForm {...(props.templateId === undefined ? {} : { templateId: props.templateId })} /> : null}
    </Modal>
  );
}

function ExportForm(props: { templateId?: string }) {
  const { t, i18n } = useTranslation();
  const page = useContentPage();
  const contentId = page.content.id;
  const summaries = useSummaries(contentId);
  const chapters = useChapters(contentId);
  const revisions = useRevisions(contentId);
  const translationList = useTranslations(contentId);
  const fetchFile = useContentExport(contentId);
  // The bilingual files start from the translation the player pairs with the same original.
  const me = useMe();
  const prefs = useSubtitlePrefs(me.data?.userId ?? "", contentId);

  const generated = (summaries.data?.templates ?? []).filter((entry) => entry.current !== undefined);
  const all = revisions.data?.revisions ?? [];
  const primaryId = revisions.data?.primaryTranscriptRevisionId;
  const hasChapters = (chapters.data?.current?.chapters.length ?? 0) > 0;

  const [summaryOn, setSummaryOn] = useState(true);
  const [templateId, setTemplateId] = useState<string | undefined>(props.templateId);
  const [chaptersOn, setChaptersOn] = useState(true);
  const [transcriptOn, setTranscriptOn] = useState(true);
  const [transcriptId, setTranscriptId] = useState<string | undefined>(undefined);
  const [subtitlesOn, setSubtitlesOn] = useState(false);
  const [subtitleId, setSubtitleId] = useState<string | undefined>(undefined);
  const [translationId, setTranslationId] = useState<string | undefined>(undefined);
  const [backlinks, setBacklinks] = useState(true);
  const [copied, setCopied] = useState(false);
  // `undefined` = not touched: ticked whenever the chosen version names speakers.
  const [markdownSpeakers, setMarkdownSpeakers] = useState<boolean | undefined>(undefined);
  const [fileSpeakers, setFileSpeakers] = useState<boolean | undefined>(undefined);
  const [speakerLabels, setSpeakerLabels] = useState<SpeakerLabelMode>("turn");
  const labelsHintId = useId();

  const readable = all.filter((revision) => revision.kind !== "translated");
  const transcriptRevision = transcriptId ?? primaryId ?? readable.at(-1)?.id;
  const subtitleRevision = subtitleId ?? primaryId ?? all.at(-1)?.id;
  // Whether a version names speakers is read from its sentences, which the reading tabs have usually fetched already.
  const transcriptSegments = useSegments(transcriptRevision);
  const subtitleSegments = useSegments(subtitleRevision);
  const transcriptHasSpeakers = transcriptSegments.data?.some((segment) => segment.speakerId !== undefined) === true;
  const subtitleHasSpeakers = subtitleSegments.data?.some((segment) => segment.speakerId !== undefined) === true;

  const exportFile = useMutation({
    mutationFn: async (action: { body: ContentExportRequest; copy?: true }) => {
      const file = await fetchFile(action.body);
      if (action.copy === true) {
        await navigator.clipboard?.writeText(await file.blob.text());
        setCopied(true);
      } else {
        await exportSaver().save(file);
      }
    },
  });

  if (summaries.isPending || revisions.isPending || chapters.isPending) return <Loading />;

  const primary = all.find((revision) => revision.id === primaryId);
  // Archived originals stay out of the choices, as in every version picker.
  const roots = rootsOf(all).filter((root) => root.id !== primaryId && !root.archived);
  const summaryTemplate = templateId !== undefined && generated.some((entry) => entry.template.id === templateId) ? templateId : generated[0]?.template.id;
  const subtitleChoices = visibleRevisions(all, primaryId, { include: [subtitleRevision] });
  const pairs = translationsOf(subtitleRevision, all);
  const track = me.data === undefined ? undefined : upgradeTrackPref(prefs.track, all);
  const translation =
    pairs.find((revision) => revision.id === translationId)?.id ??
    pickTranslation({
      originalId: subtitleRevision,
      language: track?.translation?.language,
      lockedRevisionId: track?.translation?.lockedRevisionId,
      revisions: all,
      currents: translationCurrents(translationList.data?.translations),
    })?.id ??
    pairs[0]?.id;
  const label = (revision: TranscriptRevisionDto): string => revisionLabel(revision, primaryId, t, i18n, all);

  const choice: MarkdownChoice = {
    summaryTemplateId: summaryOn ? summaryTemplate : undefined,
    chapters: chaptersOn && hasChapters,
    transcriptRevisionId: transcriptOn ? transcriptRevision : undefined,
    subtitlesRevisionId: subtitlesOn ? subtitleRevision : undefined,
    backlinks,
    includeSpeakers: transcriptHasSpeakers && (markdownSpeakers ?? true),
  };
  const filesWithSpeakers = subtitleHasSpeakers && (fileSpeakers ?? true);
  const speakerChoice: SubtitleSpeakerChoice | undefined = filesWithSpeakers ? { labels: speakerLabels } : undefined;
  const nothing = choice.summaryTemplateId === undefined && !choice.chapters && choice.transcriptRevisionId === undefined && choice.subtitlesRevisionId === undefined;
  const select = "h-7 max-w-80 rounded border border-line bg-surface px-1 text-xs";

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="export-dialog">
      <div className="grid gap-6 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-medium">{t("contentView.export.sections")}</legend>
          <label className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={summaryOn && summaryTemplate !== undefined} disabled={summaryTemplate === undefined} onChange={(event) => setSummaryOn(event.target.checked)} data-testid="export-summary" />
            {t("contentView.export.summary")}
            {generated.length > 1 ? (
              <select className={select} value={summaryTemplate} onChange={(event) => setTemplateId(event.target.value)} aria-label={t("contentView.summary.templates")}>
                {generated.map((entry) => (
                  <option key={entry.template.id} value={entry.template.id}>
                    {templateName(entry.template, t)}
                  </option>
                ))}
              </select>
            ) : null}
          </label>
          {hasChapters ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={chaptersOn} onChange={(event) => setChaptersOn(event.target.checked)} data-testid="export-chapters" />
              {t("contentView.export.chapters")}
            </label>
          ) : null}
          <label className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={transcriptOn && transcriptRevision !== undefined} disabled={transcriptRevision === undefined} onChange={(event) => setTranscriptOn(event.target.checked)} data-testid="export-transcript" />
            {t("contentView.export.transcript")}
            {transcriptRevision === undefined ? null : (
              <select className={select} value={transcriptRevision} onChange={(event) => setTranscriptId(event.target.value)} aria-label={t("contentView.export.transcript")} data-testid="export-transcript-revision">
                {primary === undefined ? null : <option value={primary.id}>{t("contentView.export.transcriptPrimary", { label: label(primary) })}</option>}
                {roots.map((root) => (
                  <option key={root.id} value={root.id}>
                    {t("contentView.export.transcriptRoot", { label: label(root) })}
                  </option>
                ))}
              </select>
            )}
          </label>
          {transcriptOn && transcriptHasSpeakers ? (
            <label className="flex items-center gap-2 pl-6 text-xs">
              <input type="checkbox" checked={markdownSpeakers ?? true} onChange={(event) => setMarkdownSpeakers(event.target.checked)} data-testid="export-markdown-speakers" />
              {t("speakerTools.export.includeSpeakers")}
            </label>
          ) : null}
          <label className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={subtitlesOn && subtitleRevision !== undefined} disabled={subtitleRevision === undefined} onChange={(event) => setSubtitlesOn(event.target.checked)} data-testid="export-subtitles" />
            {t("contentView.export.subtitles")}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={backlinks} onChange={(event) => setBacklinks(event.target.checked)} data-testid="export-backlinks" />
            {t("contentView.export.backlinks")}
          </label>
          {subtitleRevision === undefined ? null : (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">{t("contentView.export.subtitleRevision")}</span>
              <select className={select} value={subtitleRevision} onChange={(event) => setSubtitleId(event.target.value)} data-testid="export-subtitle-revision">
                {subtitleChoices.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {label(revision)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <span className="font-medium">{t("contentView.export.markdown")}</span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={nothing || exportFile.isPending} onClick={() => exportFile.mutate({ body: markdownExportBody(choice), copy: true })} data-testid="export-copy">
                <Copy size={14} />
                {copied ? t("common.action.copied") : t("contentView.export.copyMarkdown")}
              </Button>
              <Button size="sm" variant="primary" disabled={nothing || exportFile.isPending} onClick={() => exportFile.mutate({ body: markdownExportBody(choice) })} data-testid="export-markdown">
                <Download size={14} />
                {t("contentView.export.downloadMarkdown")}
              </Button>
            </div>
            {nothing ? <p className="text-xs text-muted">{t("contentView.export.nothingSelected")}</p> : null}
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-medium">{t("contentView.export.subtitleFiles")}</span>
            {pairs.length > 1 ? (
              <label className="flex items-center gap-2 text-xs">
                <span className="text-muted">{t("contentView.export.translation")}</span>
                <select className={select} value={translation} onChange={(event) => setTranslationId(event.target.value)} data-testid="export-translation">
                  {pairs.map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      {label(revision)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {subtitleHasSpeakers ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={fileSpeakers ?? true} onChange={(event) => setFileSpeakers(event.target.checked)} data-testid="export-speakers" />
                  {t("speakerTools.export.includeSpeakers")}
                </label>
                {filesWithSpeakers ? (
                  <label className="flex items-center gap-2">
                    <span className="text-muted">{t("speakerTools.export.labels")}</span>
                    <select className={select} value={speakerLabels} onChange={(event) => setSpeakerLabels(event.target.value as SpeakerLabelMode)} aria-describedby={labelsHintId} data-testid="export-speaker-labels">
                      {SPEAKER_LABEL_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {t(`speakerTools.export.label.${mode}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            ) : null}
            {filesWithSpeakers ? (
              <p id={labelsHintId} className="text-xs text-muted" data-testid="export-speaker-labels-hint">
                {t("speakerTools.export.labelsHint")}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {SUBTITLE_EXPORT_FORMATS.map((format) => {
                const bilingual = BILINGUAL_EXPORT_FORMATS.has(format);
                return (
                  <Button
                    key={format}
                    size="sm"
                    disabled={subtitleRevision === undefined || (bilingual && translation === undefined) || exportFile.isPending}
                    onClick={() => {
                      if (subtitleRevision === undefined) return;
                      exportFile.mutate({ body: subtitleExportBody(format, subtitleRevision, translation, speakerChoice) });
                    }}
                    data-testid={`export-format-${format}`}
                  >
                    {t(`contentView.export.format.${format}`)}
                  </Button>
                );
              })}
            </div>
            {pairs.length === 0 ? <p className="text-xs text-muted">{t("contentView.export.noTranslation")}</p> : null}
          </div>
          {exportFile.error instanceof ApiError ? <ErrorView error={exportFile.error.error} /> : null}
        </div>
      </div>
    </div>
  );
}
