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
import { useContentExport, useExportFigureCount } from "../../export/export-data.ts";
import { upgradeTrackPref, useSubtitlePrefs } from "../../player/subtitle-prefs.ts";
import { exportSaver } from "../../export/export-saver.ts";
import { Button } from "../../ui/button.tsx";
import { Checkbox } from "../../ui/checkbox.tsx";
import { CopyLabel, useCopyFeedback } from "../../ui/copy-feedback.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { NativeSelect } from "../../ui/native-select.tsx";
import { FieldHint, NOTE_TEXT_CLASS } from "../../ui/notice.tsx";
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
  /** Put the figures into the transcript section; the download becomes a zip. Only meaningful while that section is ticked. */
  figures?: boolean;
}

/** The Markdown export request: only ticked sections, each naming its revision. */
export function markdownExportBody(choice: MarkdownChoice): MarkdownExportRequest {
  return {
    format: "markdown",
    sections: {
      ...(choice.summaryTemplateId === undefined ? {} : { summary: { templateId: choice.summaryTemplateId } }),
      ...(choice.chapters ? { chapters: true } : {}),
      ...(choice.transcriptRevisionId === undefined
        ? {}
        : { transcript: { revisionId: choice.transcriptRevisionId, ...(choice.figures === true ? { figures: true } : {}) } }),
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
  figures?: boolean,
): SubtitleExportRequest {
  const base: SubtitleExportRequest =
    BILINGUAL_EXPORT_FORMATS.has(format) && translationRevisionId !== undefined ? { format, revisionId, translationRevisionId } : { format, revisionId };
  // Only TXT carries figures; the other formats never ask for them.
  const withFigures: SubtitleExportRequest = figures === true && format === "txt" ? { ...base, figures: true } : base;
  if (speakers === undefined) return withFigures;
  return { ...withFigures, includeSpeakers: true, ...(SPEAKER_LABELED_FORMATS.has(format) ? { speakerLabels: speakers.labels } : {}) };
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
    <Modal
      open={props.open}
      onOpenChange={(open) => (open ? undefined : props.onClose())}
      title={t("contentView.export.title")}
      wide
      // Every export starts from its own button in the body; the footer only closes, in reach however long the body.
      footer={
        <Button onClick={props.onClose} data-testid="export-close">
          {t("common.action.close")}
        </Button>
      }
    >
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
  const figureCount = useExportFigureCount(contentId);
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
  const copyFeedback = useCopyFeedback();
  // `undefined` = not touched: ticked whenever the chosen version names speakers.
  const [markdownSpeakers, setMarkdownSpeakers] = useState<boolean | undefined>(undefined);
  const [fileSpeakers, setFileSpeakers] = useState<boolean | undefined>(undefined);
  const [speakerLabels, setSpeakerLabels] = useState<SpeakerLabelMode>("turn");
  const labelsHintId = useId();
  const [markdownFigures, setMarkdownFigures] = useState(false);
  const [txtFigures, setTxtFigures] = useState(false);
  const [savedAs, setSavedAs] = useState<string | undefined>(undefined);
  const copyNoteId = useId();

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
      setSavedAs(undefined);
      const file = await fetchFile(action.body);
      if (action.copy === true) {
        // Shows as copied only when the clipboard took it (plain http has no Clipboard API).
        await copyFeedback.copy(await file.blob.text());
      } else {
        // Cancelling a save dialog is no export: nothing to confirm.
        setSavedAs(await exportSaver().save(file));
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
  // A package is made from an original; a translation travels inside its original's package.
  const subtitleIsTranslation = all.find((revision) => revision.id === subtitleRevision)?.kind === "translated";
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

  // Until the count is known the option stays off; a Content without figures cannot ask for them.
  const figures = figureCount.data ?? 0;
  const markdownWithFigures = markdownFigures && figures > 0;
  const txtWithFigures = txtFigures && figures > 0;
  const choice: MarkdownChoice = {
    summaryTemplateId: summaryOn ? summaryTemplate : undefined,
    chapters: chaptersOn && hasChapters,
    transcriptRevisionId: transcriptOn ? transcriptRevision : undefined,
    subtitlesRevisionId: subtitlesOn ? subtitleRevision : undefined,
    backlinks,
    includeSpeakers: transcriptHasSpeakers && (markdownSpeakers ?? true),
  };
  // The download carries the figures; the copy is text only, whatever is ticked.
  const downloadChoice: MarkdownChoice = { ...choice, figures: markdownWithFigures && choice.transcriptRevisionId !== undefined };
  const filesWithSpeakers = subtitleHasSpeakers && (fileSpeakers ?? true);
  const speakerChoice: SubtitleSpeakerChoice | undefined = filesWithSpeakers ? { labels: speakerLabels } : undefined;
  const nothing = choice.summaryTemplateId === undefined && !choice.chapters && choice.transcriptRevisionId === undefined && choice.subtitlesRevisionId === undefined;
  const select = "max-w-80";

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="export-dialog">
      <div className="grid gap-6 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-medium">{t("contentView.export.sections")}</legend>
          <label className="flex flex-wrap items-center gap-2">
            <Checkbox checked={summaryOn && summaryTemplate !== undefined} disabled={summaryTemplate === undefined} onChange={(event) => setSummaryOn(event.target.checked)} data-testid="export-summary" />
            {t("contentView.export.summary")}
            {generated.length > 1 ? (
              <NativeSelect size="sm" className={select} value={summaryTemplate} onChange={(event) => setTemplateId(event.target.value)} aria-label={t("contentView.summary.templates")}>
                {generated.map((entry) => (
                  <option key={entry.template.id} value={entry.template.id}>
                    {templateName(entry.template, t)}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
          </label>
          {hasChapters ? (
            <label className="flex items-center gap-2">
              <Checkbox checked={chaptersOn} onChange={(event) => setChaptersOn(event.target.checked)} data-testid="export-chapters" />
              {t("contentView.export.chapters")}
            </label>
          ) : null}
          <label className="flex flex-wrap items-center gap-2">
            <Checkbox checked={transcriptOn && transcriptRevision !== undefined} disabled={transcriptRevision === undefined} onChange={(event) => setTranscriptOn(event.target.checked)} data-testid="export-transcript" />
            {t("contentView.export.transcript")}
            {transcriptRevision === undefined ? null : (
              <NativeSelect size="sm" className={select} value={transcriptRevision} onChange={(event) => setTranscriptId(event.target.value)} aria-label={t("contentView.export.transcript")} data-testid="export-transcript-revision">
                {primary === undefined ? null : <option value={primary.id}>{t("contentView.export.transcriptPrimary", { label: label(primary) })}</option>}
                {roots.map((root) => (
                  <option key={root.id} value={root.id}>
                    {t("contentView.export.transcriptRoot", { label: label(root) })}
                  </option>
                ))}
              </NativeSelect>
            )}
          </label>
          {transcriptOn && transcriptHasSpeakers ? (
            <label className="flex items-center gap-2 pl-6 text-xs">
              <Checkbox checked={markdownSpeakers ?? true} onChange={(event) => setMarkdownSpeakers(event.target.checked)} data-testid="export-markdown-speakers" />
              {t("speakerTools.export.includeSpeakers")}
            </label>
          ) : null}
          {transcriptOn && transcriptRevision !== undefined ? (
            <FigureOption
              count={figureCount.data}
              checked={markdownWithFigures}
              onChange={setMarkdownFigures}
              note={t("exportFile.dialog.figuresMarkdownNote")}
              className="pl-6"
              testId="export-markdown-figures"
            />
          ) : null}
          <label className="flex flex-wrap items-center gap-2">
            <Checkbox checked={subtitlesOn && subtitleRevision !== undefined} disabled={subtitleRevision === undefined} onChange={(event) => setSubtitlesOn(event.target.checked)} data-testid="export-subtitles" />
            {t("contentView.export.subtitles")}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={backlinks} onChange={(event) => setBacklinks(event.target.checked)} data-testid="export-backlinks" />
            {t("contentView.export.backlinks")}
          </label>
          {subtitleRevision === undefined ? null : (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">{t("contentView.export.subtitleRevision")}</span>
              <NativeSelect size="sm" className={select} value={subtitleRevision} onChange={(event) => setSubtitleId(event.target.value)} data-testid="export-subtitle-revision">
                {subtitleChoices.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {label(revision)}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
        </fieldset>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <span className="font-medium">{t("contentView.export.markdown")}</span>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={nothing || exportFile.isPending}
                onClick={() => exportFile.mutate({ body: markdownExportBody(choice), copy: true })}
                {...(downloadChoice.figures === true ? { "aria-describedby": copyNoteId } : {})}
                data-testid="export-copy"
              >
                <CopyLabel copied={copyFeedback.copied} label={t("contentView.export.copyMarkdown")} />
              </Button>
              <Button size="sm" variant="primary" disabled={nothing || exportFile.isPending} onClick={() => exportFile.mutate({ body: markdownExportBody(downloadChoice) })} data-testid="export-markdown">
                <Download size={14} />
                {downloadChoice.figures === true ? t("exportFile.dialog.downloadZip") : t("contentView.export.downloadMarkdown")}
              </Button>
            </div>
            {downloadChoice.figures === true ? (
              <p id={copyNoteId} className={NOTE_TEXT_CLASS} data-testid="export-copy-note">
                {t("exportFile.dialog.copyWithoutFigures")}
              </p>
            ) : null}
            {nothing ? <p className={NOTE_TEXT_CLASS}>{t("contentView.export.nothingSelected")}</p> : null}
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-medium">{t("contentView.export.subtitleFiles")}</span>
            {pairs.length > 1 ? (
              <label className="flex items-center gap-2 text-xs">
                <span className="text-muted">{t("contentView.export.translation")}</span>
                <NativeSelect size="sm" className={select} value={translation} onChange={(event) => setTranslationId(event.target.value)} data-testid="export-translation">
                  {pairs.map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      {label(revision)}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
            {subtitleHasSpeakers ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                <label className="flex items-center gap-2">
                  <Checkbox checked={fileSpeakers ?? true} onChange={(event) => setFileSpeakers(event.target.checked)} data-testid="export-speakers" />
                  {t("speakerTools.export.includeSpeakers")}
                </label>
                {filesWithSpeakers ? (
                  <label className="flex items-center gap-2">
                    <span className="text-muted">{t("speakerTools.export.labels")}</span>
                    <NativeSelect size="sm" className={select} value={speakerLabels} onChange={(event) => setSpeakerLabels(event.target.value as SpeakerLabelMode)} aria-describedby={labelsHintId} data-testid="export-speaker-labels">
                      {SPEAKER_LABEL_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {t(`speakerTools.export.label.${mode}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                ) : null}
              </div>
            ) : null}
            {filesWithSpeakers ? (
              <FieldHint id={labelsHintId} testId="export-speaker-labels-hint">
                {t("speakerTools.export.labelsHint")}
              </FieldHint>
            ) : null}
            {/* One row per format: the button and what the file carries, so the choice is made knowing what a re-import brings back. */}
            <ul className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2" data-testid="export-formats">
              {SUBTITLE_EXPORT_FORMATS.map((format) => {
                const bilingual = BILINGUAL_EXPORT_FORMATS.has(format);
                const zipped = format === "txt" && txtWithFigures;
                const row = (
                  <FormatRow
                    key={format}
                    format={format}
                    {...(zipped ? { label: t("exportFile.dialog.txtZip"), note: t("exportFile.dialog.figuresTxtNote") } : {})}
                    disabled={subtitleRevision === undefined || (bilingual && translation === undefined) || exportFile.isPending}
                    onExport={() => {
                      if (subtitleRevision === undefined) return;
                      exportFile.mutate({ body: subtitleExportBody(format, subtitleRevision, translation, speakerChoice, zipped) });
                    }}
                  />
                );
                if (format !== "txt") return row;
                // The TXT figure option sits right under its format, in the note column.
                return [
                  row,
                  <li key="txt-figures" className="col-span-2 grid grid-cols-subgrid">
                    <FigureOption count={figureCount.data} checked={txtWithFigures} onChange={setTxtFigures} className="col-start-2" testId="export-txt-figures" />
                  </li>,
                ];
              })}
              <FormatRow
                format="ambersub"
                disabled={subtitleRevision === undefined || subtitleIsTranslation || exportFile.isPending}
                onExport={() => {
                  if (subtitleRevision !== undefined) exportFile.mutate({ body: { format: "ambersub", revisionId: subtitleRevision } });
                }}
              />
            </ul>
            {subtitleIsTranslation ? (
              <p className={NOTE_TEXT_CLASS} data-testid="export-ambersub-translated">
                {t("contentView.export.ambersubTranslated")}
              </p>
            ) : null}
            {pairs.length === 0 ? <p className={NOTE_TEXT_CLASS}>{t("contentView.export.noTranslation")}</p> : null}
          </div>
          {savedAs !== undefined && !exportFile.isPending ? (
            <p role="status" className={NOTE_TEXT_CLASS} data-testid="export-saved">
              {t("exportFile.dialog.saved", { filename: savedAs })}
            </p>
          ) : null}
          {exportFile.error instanceof ApiError ? <ErrorView error={exportFile.error.error} /> : null}
        </div>
      </div>
    </div>
  );
}

/** A subtitle file button with its one-line note, the note read as the button's description. */
function FormatRow(props: { format: SubtitleExportFormat | "ambersub"; disabled: boolean; onExport: () => void; label?: string; note?: string }) {
  const { t } = useTranslation();
  const noteId = useId();
  return (
    <li className="col-span-2 grid grid-cols-subgrid items-center">
      <Button size="sm" className="justify-self-start" disabled={props.disabled} onClick={props.onExport} aria-describedby={noteId} data-testid={`export-format-${props.format}`}>
        {props.label ?? t(`contentView.export.format.${props.format}`)}
      </Button>
      <span id={noteId} className="text-note text-muted" data-testid={`export-note-${props.format}`}>
        {props.note ?? t(`contentView.export.formatNote.${props.format}`)}
      </span>
    </li>
  );
}

/**
 * 「包含插图与备注（N 张）」: off by default, so an export is what it always was until asked.
 * Without figures it is disabled and says why right beside it; while the count loads it is
 * disabled without a number. When ticked, `note` (if any) says what the download becomes.
 */
function FigureOption(props: { count: number | undefined; checked: boolean; onChange: (checked: boolean) => void; note?: string; className?: string; testId: string }) {
  const { t } = useTranslation();
  const hintId = useId();
  const none = props.count === 0;
  const hint = none ? t("exportFile.dialog.figuresNone") : props.checked ? props.note : undefined;
  return (
    <div className={`flex flex-col gap-0.5 text-xs ${props.className ?? ""}`}>
      <label className={`flex items-center gap-2 ${props.count === undefined || none ? "text-muted" : ""}`}>
        <Checkbox
          checked={props.checked}
          disabled={props.count === undefined || none}
          onChange={(event) => props.onChange(event.target.checked)}
          {...(hint === undefined ? {} : { "aria-describedby": hintId })}
          data-testid={props.testId}
        />
        {props.count === undefined ? t("exportFile.dialog.figuresLoading") : t("exportFile.dialog.figures", { count: props.count })}
      </label>
      {hint === undefined ? null : (
        <span id={hintId} className="pl-6 text-note text-muted" data-testid={`${props.testId}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
