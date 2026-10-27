import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, Download, History, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ChapterRevisionDto } from "../../../shared/dto/chapter.ts";
import { summaryRevisionListDtoSchema, type ContentSummariesDto, type SummaryRevisionDto } from "../../../shared/dto/summary.ts";
import { taskAcceptedDtoSchema, type TaskDetailDto } from "../../../shared/dto/task.ts";
import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { isMarked, joinReading, readingParagraphs } from "../../../shared/reading.ts";
import { z } from "zod";
import { useApi, useTask } from "../../api/context.tsx";
import { useOptionalChatComposer } from "../../chat/chat-composer.tsx";
import { useProviders, useSettings } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { plainText } from "../../components/plain-text.ts";
import { RichText } from "../../components/rich-text.tsx";
import { ContentTaskFlow, TaskFlow, type RedoStage } from "../../components/task-flow.tsx";
import { formatDuration } from "../../format.ts";
import { usePlayerController } from "../../player/player-controller.tsx";
import { Button } from "../../ui/button.tsx";
import { copyText } from "../../ui/clipboard.ts";
import { useContextMenuTarget, type MenuAction, type MenuHit } from "../../ui/context-menu.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { ApiError } from "../../api/client.ts";
import { useContentPage } from "./content-context.tsx";
import { ExportDialog } from "./export-dialog.tsx";
import { contentKeys, useChapters, useLatestRedos, useLatestTask, useSegments, useSummaries } from "./content-data.ts";
import { templateName } from "./labels.ts";
import { explainSelectionEntries } from "./sentence-menu.tsx";

type TemplateEntry = ContentSummariesDto["templates"][number];

/** 总结 tab: template switcher, explicit generation, citations, chapters. */
export function SummaryTab() {
  const { t } = useTranslation();
  const page = useContentPage();
  const contentId = page.content.id;
  const summaries = useSummaries(contentId);
  const settings = useSettings();
  const [picked, setPicked] = useState<string | undefined>(undefined);

  if (summaries.isPending) return <Loading />;
  if (summaries.isError) {
    return summaries.error instanceof ApiError ? <ErrorView error={summaries.error.error} /> : <EmptyState title={t("common.state.loadFailed")} />;
  }
  const templates = summaries.data.templates;
  // Without a stored default the server's default is the first builtin template.
  const fallbackId = settings.data?.defaultSummaryTemplateId ?? templates.find((entry) => entry.template.builtin)?.template.id;
  const selected =
    templates.find((entry) => entry.template.id === picked) ??
    templates.find((entry) => entry.template.id === fallbackId && entry.current !== undefined) ??
    templates.find((entry) => entry.current !== undefined) ??
    templates.find((entry) => entry.template.id === fallbackId) ??
    templates[0];
  if (selected === undefined) {
    return <EmptyState title={t("contentView.summary.noTemplates")} />;
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      <TemplateSwitcher templates={templates} selectedId={selected.template.id} onPick={setPicked} />
      <TemplatePanel key={selected.template.id} entry={selected} />
    </div>
  );
}

type TemplateStatus = "generating" | "queued" | "waitingConfiguration" | "generated" | "notGenerated";

/**
 * A template with an unfinished Task is not necessarily being written: the Task may not
 * have reached its summary stage yet, or that stage may wait for a model.
 * Until the Task's detail arrives it counts as generating, as before.
 */
export function statusOf(entry: TemplateEntry, task: TaskDetailDto | undefined): TemplateStatus {
  const settled = entry.current === undefined ? "notGenerated" : "generated";
  if (entry.activeTaskId === undefined) return settled;
  if (task === undefined) return "generating";
  const summary = task.stageRuns.filter((run) => run.stage === "summary").at(-1);
  switch (summary?.status) {
    case "running":
      return "generating";
    case "waiting_configuration":
      return "waitingConfiguration";
    case undefined:
    case "pending":
      return "queued";
    default:
      return settled;
  }
}

function TemplateStatusLabel(props: { entry: TemplateEntry }) {
  const { t } = useTranslation();
  const task = useTask(props.entry.activeTaskId);
  return <span className="ml-1 text-muted">{t(`contentView.summary.status.${statusOf(props.entry, task.detail)}`)}</span>;
}

function TemplateSwitcher(props: { templates: TemplateEntry[]; selectedId: string; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t("contentView.summary.templates")}>
      {props.templates.map((entry) => {
        const active = entry.template.id === props.selectedId;
        return (
          <button
            key={entry.template.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`summary-template-${entry.template.id}`}
            className={`rounded-full border px-2.5 py-1 text-xs ${active ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-sunken"}`}
            onClick={() => props.onPick(entry.template.id)}
          >
            {templateName(entry.template, t)}
            <TemplateStatusLabel entry={entry} />
          </button>
        );
      })}
    </div>
  );
}

function TemplatePanel(props: { entry: TemplateEntry }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const player = usePlayerController();
  const providers = useProviders();
  const settings = useSettings();
  const latestTask = useLatestTask(page.content.id);
  const { entry } = props;
  const current = entry.current;
  const segments = useSegments(current?.transcriptRevisionId);
  const [history, setHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);

  const times = useMemo(() => new Map((segments.data ?? []).map((segment) => [segment.id, segment.startMs])), [segments.data]);
  const timeOf = (segmentId: string): number | undefined => times.get(segmentId);
  const generate = useMutation({
    mutationFn: () =>
      client.post(`/api/contents/${encodeURIComponent(page.content.id)}/summaries`, taskAcceptedDtoSchema, {
        body: {
          templateId: entry.template.id,
          ...(settings.data?.defaultModelRef === undefined ? {} : { modelRef: settings.data.defaultModelRef }),
        },
        idempotent: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.summaries(page.content.id) });
    },
  });
  const configured = (providers.data?.items.length ?? 0) > 0;
  const copyAll = (text: string): void => {
    void copyText(text).then((copied) => setCopied(copied));
  };
  const explainEntries = useExplainEntries();
  const bodyMenu = useContextMenuTarget<HTMLDivElement>((hit) => {
    if (current === undefined) return undefined;
    const text = plainText(current.body, timeOf);
    return {
      kind: "text",
      selectionEntries: explainEntries(hit),
      entries: [
        { id: "copy-all", label: t("common.menu.copyAll"), icon: <Copy size={14} aria-hidden="true" />, onSelect: () => copyAll(text) },
        { id: "export", label: t("contentView.summary.exportMenu"), icon: <Download size={14} aria-hidden="true" />, onSelect: () => setExporting(true) },
      ],
    };
  });

  const onCitation = (segmentId: string): void => {
    const citation = current?.citations.find((item) => item.segmentId === segmentId);
    if (citation === undefined) return;
    page.select({ revisionId: citation.transcriptRevisionId, segmentId }, times.get(segmentId));
  };

  const generateButton = configured ? (
    <Button size="sm" variant={current === undefined ? "primary" : "secondary"} onClick={() => generate.mutate()} disabled={entry.activeTaskId !== undefined || generate.isPending} data-testid="summary-generate">
      {current === undefined ? <Sparkles size={14} /> : <RefreshCw size={14} />}
      {current === undefined ? t("contentView.summary.generate") : t("contentView.summary.regenerate")}
    </Button>
  ) : (
    <Link to="/settings/models" className="inline-flex h-7 items-center rounded-md border border-line px-2 text-xs" data-testid="summary-configure">
      {t("common.action.goConfigure")}
    </Link>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {generateButton}
        <Button
          size="sm"
          variant="ghost"
          disabled={current === undefined}
          onClick={() => {
            if (current !== undefined) copyAll(plainText(current.body, timeOf));
          }}
        >
          <Copy size={14} />
          {copied ? t("common.action.copied") : t("common.action.copy")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setExporting(true)} data-testid="summary-export">
          <Download size={14} />
          {t("contentView.summary.export")}
        </Button>
        <Button size="sm" variant="ghost" disabled={entry.artifactId === undefined} onClick={() => setHistory(true)}>
          <History size={14} />
          {t("contentView.summary.history")}
        </Button>
      </div>
      {!configured ? <p className="text-xs text-muted">{t("contentView.summary.needsModel")}</p> : null}
      {generate.error instanceof ApiError ? <ErrorView error={generate.error.error} /> : null}
      {entry.activeTaskId !== undefined ? <TaskFlow taskId={entry.activeTaskId} /> : null}
      {entry.stale ? (
        <div className="rounded-md border border-line bg-accent-soft px-3 py-2 text-xs" data-testid="summary-stale">
          {t(`contentView.stale.${entry.staleReason ?? "transcript_changed"}`)}
        </div>
      ) : null}
      {current === undefined ? (
        <SummaryEmpty
          latestTaskId={entry.activeTaskId === undefined ? (latestTask.data?.id ?? undefined) : undefined}
          summaryTemplateId={latestTask.data?.templateId}
        />
      ) : (
        <>
          {current.quality === "degraded" ? <p className="text-xs text-muted">{t("contentView.summary.degraded")}</p> : null}
          <div ref={bodyMenu} data-testid="summary-body" data-explainable>
            <RichText source={current.body} timeOf={timeOf} onCitation={onCitation} />
          </div>
        </>
      )}
      <ChapterSection onSeek={(ms) => player.seek(ms)} />
      <ExportDialog open={exporting} onClose={() => setExporting(false)} templateId={entry.template.id} />
      {entry.artifactId === undefined ? null : (
        <HistoryDialog open={history} onClose={() => setHistory(false)} artifactId={entry.artifactId} timeOf={timeOf} />
      )}
    </div>
  );
}

/** "Explain the selection" for the summary's menus; summary text quotes no sentence. */
function useExplainEntries(): (hit: MenuHit) => MenuAction[] {
  const { t } = useTranslation();
  const composer = useOptionalChatComposer();
  return (hit) =>
    composer === undefined
      ? []
      : explainSelectionEntries(hit, t, (quote, question) => {
          composer.explain(quote, question);
          window.getSelection()?.removeAllRanges();
        });
}

/**
 * The stages whose later redos fold into the processing Task's flow; a summary redo counts
 * only for the template the processing Task summarized.
 */
const FOLDED_REDO_STAGES = ["asr", "proofread", "chapter", "summary"] as const satisfies readonly RedoStage[];

function SummaryEmpty(props: { latestTaskId: string | undefined; summaryTemplateId: string | undefined }) {
  const { t } = useTranslation();
  const page = useContentPage();
  const redos = useLatestRedos(page.content.id, FOLDED_REDO_STAGES, props.summaryTemplateId);
  return (
    <div className="flex flex-col gap-3" data-testid="summary-empty">
      <EmptyState title={t("contentView.summary.empty")} hint={t("contentView.summary.emptyHint")} />
      {props.latestTaskId === undefined ? null : <ContentTaskFlow taskId={props.latestTaskId} redos={redos.data ?? {}} />}
    </div>
  );
}

/**
 * Every revision of one template's summary, newest first: switch the current one, or delete an
 * earlier one behind a second click. The current revision and those a collection summary was
 * built from stay, so they offer no delete.
 */
function HistoryDialog(props: { open: boolean; onClose: () => void; artifactId: string; timeOf: (id: string) => number | undefined }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const revisionsKey = ["summary-revisions", props.artifactId];
  const revisions = useQuery({
    queryKey: revisionsKey,
    queryFn: () => client.get(`/api/summaries/${encodeURIComponent(props.artifactId)}/revisions`, summaryRevisionListDtoSchema),
    enabled: props.open,
  });
  const makeCurrent = useMutation({
    mutationFn: (revision: SummaryRevisionDto) =>
      client.put(`/api/summaries/${encodeURIComponent(props.artifactId)}/current`, z.unknown(), { body: { revisionId: revision.id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.summaries(page.content.id) });
      void queryClient.invalidateQueries({ queryKey: revisionsKey });
    },
  });
  const remove = useMutation({
    mutationFn: (revisionId: string) =>
      client.delete(`/api/summaries/${encodeURIComponent(props.artifactId)}/revisions/${encodeURIComponent(revisionId)}`, summaryRevisionListDtoSchema),
    onSuccess: (list) => {
      setConfirming(undefined);
      queryClient.setQueryData(revisionsKey, list);
      void queryClient.invalidateQueries({ queryKey: contentKeys.summaries(page.content.id) });
      // A deleted summary revision no longer holds the transcript revisions it cited.
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(page.content.id) });
    },
    onError: () => {
      setConfirming(undefined);
      // A refusal means the list is out of date (switched or frozen elsewhere); read it again.
      void queryClient.invalidateQueries({ queryKey: revisionsKey });
    },
  });
  const frozen = new Set(revisions.data?.frozenRevisionIds ?? []);
  return (
    <Modal open={props.open} onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("contentView.summary.history")} wide>
      {remove.error instanceof ApiError ? <ErrorView error={remove.error.error} /> : null}
      {revisions.data === undefined ? (
        <Loading />
      ) : (
        <ul className="flex flex-col gap-3">
          {[...revisions.data.items].reverse().map((revision) => {
            const isCurrent = revision.id === revisions.data.currentRevisionId;
            const isFrozen = frozen.has(revision.id);
            const deleting = remove.isPending && remove.variables === revision.id;
            return (
              <li key={revision.id} className="rounded-md border border-line p-3" data-testid="summary-history-item" data-revision-id={revision.id}>
                <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
                  <span>{new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(revision.createdAt)}</span>
                  {isCurrent ? (
                    <span>{t("contentView.summary.currentVersion")}</span>
                  ) : (
                    <span className="flex items-center gap-1">
                      {confirming === revision.id ? (
                        <>
                          <span>{t("contentView.summary.deleteVersionHint")}</span>
                          <Button size="sm" variant="ghost" disabled={deleting} onClick={() => setConfirming(undefined)}>
                            {t("common.action.cancel")}
                          </Button>
                          <Button size="sm" variant="danger" disabled={deleting} onClick={() => remove.mutate(revision.id)} data-testid="summary-history-delete-confirm">
                            {t("contentView.summary.deleteVersionConfirm")}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" disabled={deleting} onClick={() => makeCurrent.mutate(revision)}>
                            {t("contentView.summary.useVersion")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isFrozen || deleting}
                            title={isFrozen ? t("contentView.summary.deleteVersionFrozen") : t("contentView.summary.deleteVersion")}
                            aria-label={t("contentView.summary.deleteVersion")}
                            onClick={() => {
                              remove.reset();
                              setConfirming(revision.id);
                            }}
                            data-testid="summary-history-delete"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </Button>
                        </>
                      )}
                    </span>
                  )}
                </div>
                <div className="max-h-48 overflow-auto">
                  <RichText source={revision.body} timeOf={props.timeOf} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/**
 * Chapters in timeline order under the summary: title, one-line gist, timestamp, original text.
 * Regenerating writes AI chapters from the current primary transcript, also over platform chapters.
 */
function ChapterSection(props: { onSeek: (ms: number) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const settings = useSettings();
  const providers = useProviders();
  const contentId = page.content.id;
  const chapters = useChapters(contentId);
  const primary = useSegments(page.primaryRevisionId);
  const list = chapters.data?.current?.chapters ?? [];
  const explainEntries = useExplainEntries();
  const regenerate = useMutation({
    mutationFn: () =>
      client.post(`/api/contents/${encodeURIComponent(contentId)}/chapters/regenerate`, taskAcceptedDtoSchema, {
        body: settings.data?.defaultModelRef === undefined ? {} : { modelRef: settings.data.defaultModelRef },
        idempotent: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.chapters(contentId) });
    },
  });
  const activeTaskId = chapters.data?.activeTaskId;
  const running = activeTaskId !== undefined;
  // Without a model the Task would only wait for configuration, so offer the way there instead.
  const configured = (providers.data?.items.length ?? 0) > 0;
  // The server freezes the primary transcript into the Task, so there is nothing to regenerate from without one.
  const hasTranscript = page.primaryRevisionId !== undefined;
  // Only a selection in the expanded chapter text has something to offer; elsewhere the
  // browser keeps its own menu.
  const menuTarget = useContextMenuTarget<HTMLElement>((hit) => {
    const selectionEntries = explainEntries(hit);
    return selectionEntries.length === 0 ? undefined : { kind: "text", selectionEntries, entries: [] };
  });
  if (list.length === 0) return null;
  return (
    <section ref={menuTarget} className="mt-2 border-t border-line pt-3" data-testid="chapter-section" data-explainable>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("contentView.chapters.title")}</h2>
        {configured ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={running || !hasTranscript || regenerate.isPending}
            onClick={() => regenerate.mutate()}
            data-testid="chapters-regenerate"
          >
            <RefreshCw size={14} />
            {running ? t("contentView.chapters.regenerating") : t("contentView.chapters.regenerate")}
          </Button>
        ) : (
          <Link to="/settings/models" className="inline-flex h-7 items-center rounded-md border border-line px-2 text-xs" data-testid="chapters-configure">
            {t("common.action.goConfigure")}
          </Link>
        )}
      </div>
      {activeTaskId === undefined ? null : (
        <div className="mb-2">
          <TaskFlow taskId={activeTaskId} />
        </div>
      )}
      {regenerate.error instanceof ApiError ? (
        <div className="mb-2">
          <ErrorView error={regenerate.error.error} />
        </div>
      ) : null}
      {chapters.data?.current?.stale === true ? <p className="mb-2 text-xs text-muted">{t("contentView.chapters.stale")}</p> : null}
      <ol className="flex flex-col gap-1">
        {list.map((chapter, index) => (
          <ChapterItem key={`${chapter.startMs}-${index}`} chapter={chapter} segments={primary.data ?? []} onSeek={props.onSeek} />
        ))}
      </ol>
    </section>
  );
}

function ChapterItem(props: { chapter: ChapterRevisionDto["chapters"][number]; segments: TranscriptSegmentDto[]; onSeek: (ms: number) => void }) {
  const [open, setOpen] = useState(false);
  const { chapter } = props;
  // The original text reads like the transcript tab: same paragraph breaks and separators.
  const paragraphs = useMemo(
    () => (open ? readingParagraphs(props.segments.filter((segment) => segment.startMs >= chapter.startMs && segment.startMs < chapter.endMs)) : []),
    [open, props.segments, chapter],
  );
  return (
    <li className="rounded-md px-2 py-1.5 hover:bg-sunken">
      <div className="flex items-start gap-2">
        <button type="button" className="font-mono text-xs text-accent hover:underline" data-reading-time onClick={() => props.onSeek(chapter.startMs)}>
          {formatDuration(chapter.startMs)}
        </button>
        <div className="min-w-0 flex-1">
          {/* The whole heading toggles; the expanded text stays outside it so it can be selected and copied. */}
          <button type="button" className="flex w-full items-start gap-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{chapter.title}</span>
              {chapter.summary === undefined ? null : <span className="block text-xs text-muted">{chapter.summary}</span>}
            </span>
            <span className="rounded p-0.5 text-muted" aria-hidden="true">
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </button>
          {open ? (
            <div className="mt-1 flex flex-col gap-1 text-xs leading-6" data-testid="chapter-text">
              {paragraphs.map((paragraph) => (
                <p key={paragraph.segments[0]?.id ?? String(paragraph.startMs)}>{joinReading(paragraph.segments.map((segment) => segment.text), paragraph.segments.some(isMarked))}</p>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
