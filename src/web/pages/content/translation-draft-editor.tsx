import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { transcriptRevisionDtoSchema } from "../../../shared/dto/content.ts";
import { translationDraftDtoSchema, type TranslationDraftSegment } from "../../../shared/dto/translation.ts";
import { ApiError, type ApiClient } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useMe } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { formatDuration } from "../../format.ts";
import { relockTranslation } from "../../player/subtitle-prefs.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { useContentPage } from "./content-context.tsx";
import { contentKeys, fetchAllSegments, useRevisions, useSegments, useTranslations } from "./content-data.ts";
import { languageLabel } from "./labels.ts";
import { isChineseLanguage, SentenceEditor } from "./sentence-editor.tsx";
import { draftChangedVersion, useDraftSync } from "./use-draft-sync.ts";

/** The translation draft URL of one language. */
export function translationDraftUrl(contentId: string, language: string): string {
  return `/api/contents/${encodeURIComponent(contentId)}/translations/${encodeURIComponent(language)}/draft`;
}

interface LoadedDraft {
  baseRevisionId: string;
  version: number | null;
  segments: TranslationDraftSegment[];
}

/** The language's saved draft, else a new one from its current translation. */
async function loadTranslationDraft(client: ApiClient, url: string, currentId: string | undefined): Promise<LoadedDraft> {
  try {
    const draft = await client.get(url, translationDraftDtoSchema);
    return { baseRevisionId: draft.baseRevisionId, version: draft.version, segments: draft.segments };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && currentId !== undefined) {
      const segments = await fetchAllSegments(client, currentId);
      return { baseRevisionId: currentId, version: null, segments: segments.map((segment) => ({ id: segment.id, text: segment.text })) };
    }
    throw error;
  }
}

const segmentKey = (segment: TranslationDraftSegment): string => segment.id;
const isEmpty = (segment: TranslationDraftSegment): boolean => segment.text.trim() === "";

/**
 * Editor of one language's translation. Each session is one draft lifetime; 「丢弃草稿并编辑当前
 * 译文」 ends it and starts a fresh one from the current translation.
 */
export function TranslationDraftEditor(props: { language: string; onClose: () => void }) {
  const [round, setRound] = useState(0);
  return <TranslationDraftSession key={round} round={round} language={props.language} onClose={props.onClose} onRestart={() => setRound(round + 1)} />;
}

/**
 * Sentence by sentence: time and number on top, the original sentence below in a quiet tone
 * (read-only), then the translation's input; side by side on a wide pane. Only text changes:
 * timing, order and sources stay those of the base translation. 「完成」 commits the draft as the
 * language's new current translation; a draft whose base is no longer current asks first.
 */
function TranslationDraftSession(props: { language: string; round: number; onClose: () => void; onRestart: () => void }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const contentId = page.content.id;
  const url = translationDraftUrl(contentId, props.language);
  const translations = useTranslations(contentId);
  const revisions = useRevisions(contentId);
  const userId = useMe().data?.userId;
  const entry = translations.data?.translations.find((item) => item.targetLanguage === props.language);
  const currentId = entry?.current?.id;
  const [segments, setSegments] = useState<readonly TranslationDraftSegment[] | undefined>(undefined);
  const [baseRevisionId, setBaseRevisionId] = useState<string | undefined>(undefined);
  const [expectedCurrent, setExpectedCurrent] = useState<string | undefined>(undefined);
  const [changed, setChanged] = useState<string | undefined>(undefined);

  const { sync, state } = useDraftSync<readonly TranslationDraftSegment[]>((value, expectedVersion) =>
    client.put(url, translationDraftDtoSchema, { body: { baseRevisionId: baseRevisionId ?? "", expectedVersion, segments: [...value] } }),
  );

  const initial = useQuery({
    queryKey: ["draft", contentId, "translation", props.language, props.round],
    queryFn: () => loadTranslationDraft(client, url, currentId),
    enabled: translations.isSuccess,
    staleTime: Infinity,
    gcTime: 0,
  });
  useEffect(() => {
    if (initial.data !== undefined && segments === undefined) {
      setSegments(initial.data.segments);
      setBaseRevisionId(initial.data.baseRevisionId);
      setExpectedCurrent(currentId ?? initial.data.baseRevisionId);
      sync.init(initial.data.segments, initial.data.version);
    }
  }, [initial.data, segments, sync, currentId]);

  const base = revisions.data?.revisions.find((item) => item.id === baseRevisionId);
  const baseSegments = useSegments(base === undefined ? undefined : base.id);
  const sourceSegments = useSegments(base?.parentRevisionId);
  const baseById = useMemo(() => new Map((baseSegments.data ?? []).map((segment) => [segment.id, segment])), [baseSegments.data]);
  const sourceText = useMemo(() => new Map((sourceSegments.data ?? []).map((segment) => [segment.id, segment.text])), [sourceSegments.data]);

  const renderHeader = useCallback(
    (segment: TranslationDraftSegment, index: number) => {
      const timing = baseById.get(segment.id);
      return timing === undefined
        ? t("editor.row.text", { ordinal: index + 1 })
        : t("editor.row.range", { start: formatDuration(timing.startMs), end: formatDuration(timing.endMs), ordinal: index + 1 });
    },
    [baseById, t],
  );
  const renderSource = useCallback(
    (segment: TranslationDraftSegment) => {
      const sourceId = baseById.get(segment.id)?.sourceSegmentIds[0];
      return sourceId === undefined ? null : (sourceText.get(sourceId) ?? null);
    },
    [baseById, sourceText],
  );
  const textLabel = useCallback((_segment: TranslationDraftSegment, index: number) => t("editor.row.translation", { ordinal: index + 1 }), [t]);

  const onItemsChange = useCallback(
    (next: readonly TranslationDraftSegment[]) => {
      setSegments(next);
      sync.edit(next);
    },
    [sync],
  );

  const refreshTranslations = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: contentKeys.translations(contentId) });
    await queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
  };

  const commit = useMutation({
    mutationFn: (request: { expectedRevisionId: string; allowOutdatedBase: boolean }) =>
      sync.commit((draftVersion) =>
        client.post(`${url}/commit`, transcriptRevisionDtoSchema, {
          body: { expectedRevisionId: request.expectedRevisionId, draftVersion, ...(request.allowOutdatedBase ? { allowOutdatedBase: true as const } : {}) },
        }),
      ),
    onSuccess: async (revision) => {
      // A subtitle choice locked to the edited translation moves to the new one; one following the language follows by itself.
      if (userId !== undefined && baseRevisionId !== undefined) relockTranslation(userId, contentId, baseRevisionId, revision.id);
      await refreshTranslations();
      await queryClient.invalidateQueries({ queryKey: queryKeys.content(contentId) });
      props.onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.error.code === "conflict.translation_changed") {
        const current = error.error.details?.["currentRevisionId"];
        setChanged(typeof current === "string" ? current : (currentId ?? ""));
        void refreshTranslations();
      }
    },
  });

  const discard = useMutation({
    /** `restart`: start a new draft from the current translation afterwards, instead of leaving. */
    mutationFn: (_restart: boolean) => sync.discard((version) => client.delete(`${url}?version=${version}`, z.undefined())),
    onSuccess: async (_, restart) => {
      await refreshTranslations();
      if (restart) props.onRestart();
      else props.onClose();
    },
  });

  const exit = (): void => {
    void sync.close();
    props.onClose();
  };

  if (initial.isError) {
    return initial.error instanceof ApiError ? <ErrorView error={initial.error.error} /> : null;
  }
  if (segments === undefined || baseRevisionId === undefined || revisions.isPending) return <Loading />;

  // A resumed draft needs its base to still be there, unarchived and of this language.
  const baseUsable = base !== undefined && !base.archived && base.kind === "translated" && base.language === props.language;
  if (!baseUsable) {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm" data-testid="translation-draft-unavailable">
        <p>{t("editor.translation.baseUnavailable")}</p>
        {discard.error instanceof ApiError ? <ErrorView error={discard.error.error} /> : null}
        <div className="flex gap-2">
          <Button variant="danger" size="sm" disabled={discard.isPending} onClick={() => discard.mutate(false)} data-testid="draft-discard">
            {t("editor.toolbar.discard")}
          </Button>
          <Button size="sm" onClick={exit}>
            {t("editor.toolbar.exit")}
          </Button>
        </div>
      </div>
    );
  }

  const outdated = currentId !== undefined && currentId !== baseRevisionId;
  // Freshness belongs to the draft's base, not whichever translation became current meanwhile.
  const staleBase = base.parentRevisionId !== revisions.data?.primaryTranscriptRevisionId;
  const empty = segments.filter(isEmpty).length;
  const failure = [commit.error, discard.error].find(
    (error) => error instanceof ApiError && draftChangedVersion(error) === undefined && error.error.code !== "conflict.translation_changed",
  );

  return (
    <>
      <SentenceEditor
        testId="translation-draft-editor"
        items={segments}
        onItemsChange={onItemsChange}
        keyOf={segmentKey}
        renderHeader={renderHeader}
        renderSource={renderSource}
        textLabel={textLabel}
        layout="bilingual"
        fillers={isChineseLanguage(props.language)}
        deleteWholeSentences={false}
        isInvalid={isEmpty}
        sync={state}
        onRetry={() => sync.retry()}
        onLoadLatest={() => {
          void sync.close();
          props.onRestart();
        }}
        onKeepMine={() => sync.overwrite()}
        onDiscard={() => discard.mutate(false)}
        onExit={exit}
        onCommit={() => commit.mutate({ expectedRevisionId: expectedCurrent ?? baseRevisionId, allowOutdatedBase: false })}
        busy={commit.isPending || discard.isPending}
        commitDisabled={empty > 0}
        commitNote={
          empty > 0 ? (
            <span className="text-xs text-danger" data-testid="translation-empty-count">
              {t("editor.translation.emptyCount", { count: empty })}
            </span>
          ) : null
        }
        notices={
          <>
            <p className="px-4 pt-2 text-xs font-medium text-muted">{languageLabel(props.language, t, i18n)}</p>
            {outdated ? (
              <div className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-xs" data-testid="translation-draft-outdated">
                <span>{t("editor.translation.outdated")}</span>
                <Button size="sm" className="ml-auto" disabled={discard.isPending} onClick={() => discard.mutate(true)} data-testid="translation-draft-restart">
                  {t("editor.translation.outdatedDiscard")}
                </Button>
              </div>
            ) : null}
            {staleBase ? (
              <p className="px-4 pt-2 text-xs text-muted" data-testid="translation-draft-stale">
                {t("editor.translation.stale")}
              </p>
            ) : null}
            {failure instanceof ApiError ? (
              <div className="px-4 pt-2">
                <ErrorView error={failure.error} />
              </div>
            ) : null}
          </>
        }
      />
      <Modal open={changed !== undefined} onOpenChange={(open) => (open ? undefined : setChanged(undefined))} title={t("editor.translation.conflictTitle")}>
        <p className="text-sm" data-testid="translation-draft-conflict">
          {t("editor.translation.conflictMessage")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            onClick={() => {
              setChanged(undefined);
              void sync.close();
              props.onRestart();
            }}
            data-testid="translation-draft-reload"
          >
            {t("editor.translation.reload")}
          </Button>
          <Button
            variant="primary"
            disabled={changed === ""}
            onClick={() => {
              const next = changed;
              setChanged(undefined);
              if (next === undefined || next === "") return;
              setExpectedCurrent(next);
              commit.mutate({ expectedRevisionId: next, allowOutdatedBase: true });
            }}
            data-testid="translation-draft-commit-anyway"
          >
            {t("editor.translation.commitAnyway")}
          </Button>
        </div>
      </Modal>
    </>
  );
}
