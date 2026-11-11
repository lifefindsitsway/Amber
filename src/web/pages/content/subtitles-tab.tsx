import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, Mic } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ASR_DIARIZATION_DEFAULT } from "../../../shared/defaults.ts";
import { subtitleImportResponseSchema, type TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import { STYLED_EXPORT_FORMATS, type SubtitleExportFormat, type SubtitleExportRequest } from "../../../shared/dto/export.ts";
import type { AsrModelRefDto } from "../../../shared/dto/model-ref.ts";
import type { DiarizationRequest } from "../../../shared/dto/speaker.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import type { SubtitleStyle } from "../../../shared/subtitle-style.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { useAsrProfiles, useMe, useSettings } from "../../api/queries.ts";
import { diarizationOffer } from "../../components/asr-diarization.ts";
import { AsrModelSelect, asrModelOptions, initialAsrModelRef } from "../../components/asr-model-select.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { useSaveContentExport } from "../../export/export-data.ts";
import { formatDuration } from "../../format.ts";
import { usePlayerCapabilities, usePlayerTime } from "../../player/player-controller.tsx";
import { useSubtitlePrefs } from "../../player/subtitle-prefs.ts";
import { Highlighted } from "../../search/highlighted.tsx";
import { termRanges } from "../../search/search.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { FilePicker } from "../../ui/file-picker.tsx";
import { Modal } from "../../ui/modal.tsx";
import { BurnDialog, BurnTracker } from "./burn-dialog.tsx";
import { useContentPage } from "./content-context.tsx";
import { contentKeys, revisionGroups, segmentsAt, useRevisions, useSegments, useTranslations, visibleRevisions } from "./content-data.ts";
import { subtitleExportBody, type SubtitleSpeakerChoice } from "./export-dialog.tsx";
import { revisionLabel } from "./labels.ts";
import { revisionInfo } from "./revision-info.ts";
import { DIARIZATION_UNAVAILABLE_CODE, DiarizationOptions, DiarizationUnavailableNotice, useDiarizationChoice } from "./retranscribe-diarization.tsx";
import { AsrBanner } from "./asr-banner.tsx";
import { RevisionActions } from "./revision-actions-dialog.tsx";
import { RevisionToggleBar, type RevisionToggles } from "./transcript-tab.tsx";
import { TranslationDraftEditor } from "./translation-draft-editor.tsx";
import { TranslationEditButton, useUnarchiveAndEdit } from "./translation-tab.tsx";
import { useLocatedSegment } from "./same-sentence.ts";
import { useSentenceMenu } from "./sentence-menu.tsx";
import { SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerModeFor } from "../../../shared/speaker-turns.ts";
import { speakerColorVars } from "./speakers/speaker-colors.ts";
import { speakerLabel, useSpeakers } from "./speakers/speaker-data.ts";
import { VirtualRows } from "./virtual-rows.tsx";

/**
 * The download choices for a subtitle version: the plain formats of the
 * version itself and, for a translation, the bilingual ones paired with its parent.
 */
export function subtitleDownloads(revision: TranscriptRevisionDto): Array<{ format: SubtitleExportFormat; revisionId: string; translationRevisionId?: string }> {
  const plain = (["srt", "ass", "vtt", "txt"] as const).map((format) => ({ format, revisionId: revision.id }));
  if (revision.kind !== "translated" || revision.parentRevisionId === undefined) return plain;
  const parent = revision.parentRevisionId;
  return [
    ...plain,
    ...(["srt-bilingual", "ass-bilingual"] as const).map((format) => ({ format, revisionId: parent, translationRevisionId: revision.id })),
  ];
}

/**
 * The export body of one download choice. ASS files carry the player's current subtitle
 * appearance and position; the other formats have no styling. A version with speakers names
 * them, on the first cue of each turn: the menu has no options, so it takes the export
 * dialog's defaults.
 */
export function subtitleDownloadBody(
  item: { format: SubtitleExportFormat; revisionId: string; translationRevisionId?: string },
  style: SubtitleStyle,
  hasSpeakers = false,
): SubtitleExportRequest {
  const speakers: SubtitleSpeakerChoice | undefined = hasSpeakers ? { labels: "turn" } : undefined;
  const body = subtitleExportBody(item.format, item.revisionId, item.translationRevisionId, speakers);
  return STYLED_EXPORT_FORMATS.has(item.format) ? { ...body, style } : body;
}

/** 字幕脚本 tab: versions incl. translations, `timestamp | text` rows, filter, follow playback, download, re-transcribe, import. */
export function SubtitlesTab() {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const revisions = useRevisions(page.content.id);
  const capabilities = usePlayerCapabilities();
  const time = usePlayerTime();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // A search hit opens the page with its query, which keeps narrowing the rows here.
  const [filter, setFilter] = useState(() => params.get("search") ?? "");
  const [follow, setFollow] = useState(true);
  const [importing, setImporting] = useState(false);
  const desktop = useDesktop();
  const [burning, setBurning] = useState(false);
  const [burnTaskId, setBurnTaskId] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingLanguage, setEditingLanguage] = useState<string | undefined>(undefined);
  const translations = useTranslations(page.content.id);
  const unarchiveAndEdit = useUnarchiveAndEdit(page.content.id, setEditingLanguage);

  const all = revisions.data?.revisions ?? [];
  const primaryId = revisions.data?.primaryTranscriptRevisionId;
  // A translation opened from the translation tab arrives as `?revision=`.
  const requested = params.get("revision");
  const missing = revisions.isSuccess && requested !== null && !all.some((item) => item.id === requested);
  const revision =
    all.find((item) => item.id === picked) ??
    all.find((item) => item.id === requested) ??
    all.find((item) => item.id === primaryId) ??
    visibleRevisions(all, primaryId).at(-1) ??
    all.at(-1);
  const groups = revisionGroups(all, primaryId);
  // A shown revision that sits behind a toggle (a deep link, say) opens that toggle.
  const historyOpen = showHistory || (revision !== undefined && groups.history.has(revision.id));
  const archivedOpen = showArchived || (revision !== undefined && groups.archived.has(revision.id));
  const listed = visibleRevisions(all, primaryId, { showHistory: historyOpen, showArchived: archivedOpen, include: [revision?.id] });
  const toggles: RevisionToggles = {
    historyCount: groups.history.size,
    historyOpen,
    setHistoryOpen: (open) => {
      setShowHistory(open);
      if (!open && revision !== undefined && groups.history.has(revision.id)) setPicked(primaryId);
    },
    archivedCount: groups.archived.size,
    archivedOpen,
    setArchivedOpen: (open) => {
      setShowArchived(open);
      if (!open && revision !== undefined && groups.archived.has(revision.id)) setPicked(primaryId);
    },
  };
  const segments = useSegments(revision?.id);
  const located = useLocatedSegment(revision?.id);
  const tracking = capabilities.timeTracking === "supported";
  const menuTarget = useSentenceMenu<HTMLDivElement>((segmentId) => segments.data?.find((segment) => segment.id === segmentId), { explainSentence: true });

  const download = useSaveContentExport(page.content.id);
  const userId = useMe().data?.userId;
  // Read with a placeholder until the account is known; styled downloads wait for it.
  const subtitlePrefs = useSubtitlePrefs(userId ?? "", page.content.id);
  const style: SubtitleStyle = { appearance: subtitlePrefs.appearance, placement: subtitlePrefs.placement };
  const asrProfiles = useAsrProfiles();
  const settings = useSettings();
  const [asrChoice, setAsrChoice] = useState<AsrModelRefDto | undefined>(undefined);
  const asrOptions = asrProfiles.data?.items ?? [];
  // The same starting choice as the new page: the default while it can be picked, else none.
  const asrModelRef = asrChoice ?? initialAsrModelRef(asrOptions, settings.data?.defaultAsrModelRef);
  const noAsr = asrProfiles.isSuccess && asrModelOptions(asrOptions).length === 0;
  const diarizationOffered = diarizationOffer(asrOptions, asrModelRef, page.content.durationMs);
  const diarization = useDiarizationChoice(diarizationOffered, settings.data?.asrDiarization ?? ASR_DIARIZATION_DEFAULT);
  const retranscribe = useMutation({
    mutationFn: (request: DiarizationRequest) =>
      client.post(`/api/contents/${encodeURIComponent(page.content.id)}/transcript/retranscribe`, taskAcceptedDtoSchema, {
        body: { ...(asrModelRef === undefined ? {} : { asrModelRef }), diarization: request },
        idempotent: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.latestTask(page.content.id) });
    },
  });

  const list = segments.data ?? [];
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle === "" ? list : list.filter((segment) => segment.text.toLowerCase().includes(needle));
  }, [list, filter]);
  // Overlapping sentences (one speaker cutting in) cover the same moment; the list follows the primary one.
  const current = tracking ? segmentsAt(list, time).primary : undefined;
  const hasSpeakers = list.some((segment) => segment.speakerId !== undefined);
  const speakers = useSpeakers(page.content.id, hasSpeakers);
  const speakerById = useMemo(() => new Map((speakers.data?.items ?? []).map((speaker) => [speaker.id, speaker])), [speakers.data]);
  // The same rule as the reading view: with one anonymous speaker there are no turns worth marking.
  const speakerMode = useMemo(() => speakerModeFor(list, speakers.data?.items ?? []), [list, speakers.data]);
  const followId = tracking && follow ? current?.id : undefined;
  const targetId = located.segmentId ?? followId;
  const targetIndex = targetId === undefined ? undefined : visible.findIndex((segment) => segment.id === targetId);

  if (revisions.isPending) return <Loading />;
  if (revisions.isError) {
    return revisions.error instanceof ApiError ? <ErrorView error={revisions.error.error} /> : <EmptyState title={t("common.state.loadFailed")} />;
  }

  if (editingLanguage !== undefined) {
    return <TranslationDraftEditor key={editingLanguage} language={editingLanguage} onClose={() => setEditingLanguage(undefined)} />;
  }
  // Viewing a translation offers to edit that language's current translation, as the translation tab does.
  const translationEntry =
    revision?.kind === "translated" ? translations.data?.translations.find((entry) => entry.targetLanguage === revision.language) : undefined;

  const onRow = (segment: TranscriptSegmentDto): void => {
    if (revision !== undefined) page.select({ revisionId: revision.id, segmentId: segment.id }, segment.startMs);
  };

  return (
    <div ref={menuTarget} className="flex h-full min-h-0 flex-col" {...(revision === undefined ? {} : { "data-revision-id": revision.id })}>
      <AsrBanner
        contentId={page.content.id}
        revisions={all}
        primaryId={primaryId}
        onApplySpeakers={(sourceRevisionId) => navigate({ search: `?tab=transcript&applySpeakers=${encodeURIComponent(sourceRevisionId)}` })}
      />
      {/* Two rows whose leading selects share one column, so they line up and keep the same width.
          The column leaves the other controls 16rem, about what either row needs to stay on one line. */}
      <div className="grid grid-cols-[minmax(11rem,min(22.5rem,calc(100%_-_16.75rem)))_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2" data-testid="subtitles-toolbar">
        <div className="min-w-0" data-testid="subtitles-toolbar-version">
          {revision === undefined ? null : (
            <select
              aria-label={t("contentView.transcript.version")}
              className="h-7 w-full min-w-0 rounded border border-line bg-surface px-1 text-xs"
              value={revision.id}
              onChange={(event) => setPicked(event.target.value)}
              title={revisionInfo(revision, all, t, i18n)}
              data-testid="subtitles-version"
            >
              {listed.map((item) => (
                <option key={item.id} value={item.id} title={revisionInfo(item, all, t, i18n)}>
                  {revisionLabel(item, primaryId, t, i18n, all)}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            type="search"
            className="h-7 min-w-24 max-w-40 flex-1 rounded border border-line bg-surface px-2 text-xs"
            placeholder={t("contentView.subtitles.filter")}
            aria-label={t("contentView.subtitles.filter")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {revision === undefined ? null : (
            <RevisionActions contentId={page.content.id} revision={revision} revisions={all} primaryId={primaryId} onDeleted={() => setPicked(primaryId)} />
          )}
          <RevisionToggleBar toggles={toggles} />
          {tracking ? (
            <label className="flex items-center gap-1 text-xs" data-testid="follow-toggle">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
              {t("contentView.subtitles.follow")}
            </label>
          ) : null}
          {translationEntry === undefined ? null : (
            <TranslationEditButton
              entry={translationEntry}
              archived={all.some((item) => item.id === translationEntry.current?.id && item.archived)}
              busy={unarchiveAndEdit.isPending}
              onEdit={() => setEditingLanguage(translationEntry.targetLanguage)}
              onUnarchiveAndEdit={(revisionId) => unarchiveAndEdit.mutate({ revisionId, language: translationEntry.targetLanguage })}
            />
          )}
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
            <FileUp size={14} />
            {t("contentView.subtitles.import")}
          </Button>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="subtitles-toolbar-asr">
          {noAsr || asrProfiles.isPending ? null : (
            <AsrModelSelect
              profiles={asrOptions}
              value={asrModelRef}
              onChange={setAsrChoice}
              label={t("contentView.subtitles.retranscribeModel")}
              placeholder={t("contentView.subtitles.pickAsrModel")}
              className="h-7 w-full min-w-0 rounded border border-line bg-surface px-1 text-xs"
              testId="retranscribe-model"
            />
          )}
          {noAsr || asrProfiles.isPending ? null : <DiarizationOptions offer={diarizationOffered} choice={diarization} settingPending={settings.isPending} />}
          {noAsr ? (
            <Link to="/settings/transcription" className="text-xs text-accent hover:underline" data-testid="retranscribe-configure">
              {t("contentView.subtitles.configureAsr")}
            </Link>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={retranscribe.isPending || noAsr || asrProfiles.isPending || settings.isPending || asrModelRef === undefined || diarization.invalidCount}
            title={t("contentView.subtitles.retranscribeHint")}
            onClick={() => retranscribe.mutate(diarization.request())}
            data-testid="retranscribe"
          >
            <Mic size={14} />
            {t("contentView.subtitles.retranscribe")}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="sm" variant="ghost" disabled={revision === undefined || download.isPending} data-testid="subtitles-download">
                <Download size={14} />
                {t("contentView.subtitles.download")}
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" className="z-50 min-w-36 rounded-md border border-line bg-surface p-1 text-sm shadow-lg">
                {(revision === undefined ? [] : subtitleDownloads(revision)).map((item) => (
                  <DropdownMenu.Item
                    key={item.format}
                    className="cursor-pointer rounded px-2 py-1.5 outline-none data-highlighted:bg-sunken data-disabled:cursor-default data-disabled:opacity-50"
                    disabled={STYLED_EXPORT_FORMATS.has(item.format) && userId === undefined}
                    onSelect={() => download.mutate(subtitleDownloadBody(item, style, hasSpeakers))}
                    data-testid={`subtitles-download-${item.format}`}
                  >
                    {t(`contentView.export.format.${item.format}`)}
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Label className="max-w-56 px-2 pt-1.5 pb-1 text-xs text-muted" data-testid="subtitles-ass-hint">
                  {t("contentView.subtitles.assCanvasHint")}
                </DropdownMenu.Label>
                {hasSpeakers ? (
                  <DropdownMenu.Label className="max-w-56 px-2 pt-1 pb-1 text-xs text-muted" data-testid="subtitles-speakers-hint">
                    {t("speakerTools.export.quickHint")}
                  </DropdownMenu.Label>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <Button
            size="sm"
            variant="ghost"
            disabled={!desktop || revision === undefined}
            {...(desktop ? {} : { title: t("contentView.player.clientOnly") })}
            onClick={() => setBurning(true)}
            data-testid="subtitles-burn"
          >
            {t("contentView.subtitles.burn")}
          </Button>
        </div>
      </div>
      {missing ? <p className="px-4 pt-2 text-xs text-muted" data-testid="revision-missing">{t("contentView.revisions.missing")}</p> : null}
      {located.unmatched ? <p className="px-4 pt-2 text-xs text-muted" data-testid="locate-unmatched">{t("contentView.locate.unmatched")}</p> : null}
      {download.error instanceof ApiError ? <div className="px-4 pt-2"><ErrorView error={download.error.error} /></div> : null}
      {retranscribe.error instanceof ApiError ? (
        <div className="px-4 pt-2">
          {retranscribe.error.error.code === DIARIZATION_UNAVAILABLE_CODE ? (
            <DiarizationUnavailableNotice
              error={retranscribe.error.error}
              offer={diarizationOffered}
              busy={retranscribe.isPending}
              onContinue={() => {
                diarization.setOn(false);
                retranscribe.mutate({ mode: "off" });
              }}
              onCancel={() => retranscribe.reset()}
            />
          ) : (
            <ErrorView error={retranscribe.error.error} />
          )}
        </div>
      ) : null}
      {unarchiveAndEdit.error instanceof ApiError ? <div className="px-4 pt-2"><ErrorView error={unarchiveAndEdit.error.error} /></div> : null}
      {burnTaskId === undefined ? null : (
        <div className="px-4 pt-2">
          <BurnTracker taskId={burnTaskId} title={page.content.title ?? t("contentView.untitled")} onClose={() => setBurnTaskId(undefined)} />
        </div>
      )}
      {revision === undefined ? (
        <EmptyState title={t("contentView.transcript.empty")} hint={t("contentView.transcript.emptyHint")} />
      ) : segments.isPending ? (
        <Loading />
      ) : (
        <VirtualRows
          className="min-h-0 flex-1 py-1"
          testId="subtitle-rows"
          items={visible}
          keyOf={(segment) => segment.id}
          estimateSize={36}
          scrollToIndex={targetIndex}
          render={(segment, index) => {
            const isCurrent = segment.id === current?.id;
            const isSelected = segment.id === located.segmentId;
            // The first row of a turn names its speaker; rows are compared as listed, so a
            // filter that hides a turn's first row still names the speaker on the first one left.
            const speaker = segment.speakerId === undefined ? undefined : speakerById.get(segment.speakerId);
            const turnStart = speaker !== undefined && (index === 0 || visible[index - 1]?.speakerId !== segment.speakerId);
            // Sentences nobody was assigned to form a turn of their own, marked neutrally as in the reading view.
            const unassignedStart = speakerMode && segment.speakerId === undefined && (index === 0 || visible[index - 1]?.speakerId !== undefined);
            const tagClass = `mb-0.5 flex min-w-0 items-center gap-1.5 text-xs font-medium ${index === 0 ? "" : "mt-1"}`;
            return (
              <button
                type="button"
                data-segment-id={segment.id}
                {...(isCurrent ? { "data-testid": "current-sentence" } : {})}
                className={`flex w-full flex-col px-4 py-1.5 text-left text-sm hover:bg-sunken ${isSelected ? "bg-accent-soft" : ""} ${isCurrent ? "font-medium text-accent" : ""}`}
                onClick={() => onRow(segment)}
              >
                {unassignedStart ? (
                  <span className={`${tagClass} text-muted`} data-testid="subtitle-turn-tag" data-unassigned="true">
                    <SpeakerAvatar unassigned size={16} decorative />
                    <span className="truncate" data-testid="subtitle-turn-name">{t("speakerIdentity.unassigned")}</span>
                  </span>
                ) : null}
                {turnStart ? (
                  // Above the row, not inside the text column, so the timestamps and the text keep their columns.
                  <span className={tagClass} style={{ color: speakerColorVars(speaker.colorIndex).fg }} data-testid="subtitle-turn-tag" data-speaker-id={speaker.id}>
                    <SpeakerAvatar contentId={page.content.id} speaker={speaker} size={16} decorative />
                    <span className="truncate" data-testid="subtitle-turn-name">{speakerLabel(t, speaker)}</span>
                  </span>
                ) : null}
                <span className="flex w-full gap-3">
                  <span className="w-14 shrink-0 font-mono text-xs text-muted">{formatDuration(segment.startMs)}</span>
                  <Highlighted text={segment.text} ranges={termRanges(segment.text, filter)} className="min-w-0 flex-1" />
                </span>
              </button>
            );
          }}
        />
      )}
      {desktop && burning && revision !== undefined ? (
        <BurnDialog
          key={revision.id}
          contentId={page.content.id}
          selected={revision}
          revisions={all}
          primaryId={primaryId}
          open
          onOpenChange={setBurning}
          onStarted={setBurnTaskId}
          playingAssetId={page.playingAssetId}
        />
      ) : null}
      <ImportSubtitleDialog open={importing} onClose={() => setImporting(false)} defaultLanguage={page.content.rawLanguage} />
    </div>
  );
}

function ImportSubtitleDialog(props: { open: boolean; onClose: () => void; defaultLanguage: string | undefined }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [language, setLanguage] = useState(props.defaultLanguage ?? i18n.language);
  const upload = useMutation({
    mutationFn: async () => {
      if (file === undefined) throw new Error("no file");
      const text = await file.text();
      return client.post(`/api/contents/${encodeURIComponent(page.content.id)}/subtitle-import`, subtitleImportResponseSchema, {
        body: { text, filename: file.name, ...(language.trim() === "" ? {} : { language: language.trim() }) },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(page.content.id) });
      props.onClose();
    },
  });
  return (
    <Modal open={props.open} onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("contentView.subtitles.import")}>
      <div className="flex flex-col gap-3 text-sm">
        <FilePicker accept=".srt,.vtt,.txt,.md" fileName={file?.name} onFile={setFile} label={t("contentView.subtitles.importFile")} />
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t("contentView.subtitles.importLanguage")}</span>
          <input className="h-8 rounded border border-line bg-surface px-2" value={language} onChange={(event) => setLanguage(event.target.value)} />
        </label>
        {upload.error instanceof ApiError ? <ErrorView error={upload.error.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
          <Button variant="primary" disabled={file === undefined || upload.isPending} onClick={() => upload.mutate()}>
            {t("contentView.subtitles.importSubmit")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
