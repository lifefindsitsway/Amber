import { useMutation } from "@tanstack/react-query";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { CONTENT_PACK_MERGE_DURATION_WARN_MS } from "../../../shared/defaults.ts";
import type {
  ContentPackImportJobDto,
  ContentPackPreviewDto,
  PackContentDiff,
  PackPreviewCollection,
  PackPreviewContent,
  PackRevisionDiff,
} from "../../../shared/dto/content-pack.ts";
import type { AppError } from "../../../shared/errors.ts";
import { useApi } from "../../api/context.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { localTimeStamp, pickPackOriginalsDir } from "../../desktop/bridge.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { formatDateTime, formatDuration } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { Checkbox, RadioCard } from "../../ui/checkbox.tsx";
import { Modal } from "../../ui/modal.tsx";
import { NativeSelect } from "../../ui/native-select.tsx";
import { Callout, InlineNote, NOTE_TEXT_CLASS, TEXT_ACTION_CLASS, TextAction } from "../../ui/notice.tsx";
import { CHECK_BOX, CHECK_LABEL } from "./export-card.tsx";
import { PackFooter } from "./export-dialog.tsx";
import {
  blockingOverLimit,
  blockingProblems,
  buildDecisions,
  clashingTargets,
  sharedMatches,
  canImportAsNew,
  canStart,
  changeSummary,
  collectionUsable,
  conclusionOf,
  decidingCandidates,
  draftFor,
  durationsDiffer,
  initialCollectionDraft,
  initialDraft,
  needsAttention,
  needsOriginalsDir,
  totals,
  type CollectionDraft,
  type ContentDraft,
} from "./import-model.ts";
import { commitImport, comparePack } from "./pack-api.ts";
import { bytesLabel, describedRevisionLabel, packRevisionLabel, sourceLine, titleOf } from "./pack-labels.ts";
import { revisionTimeLabel } from "../content/labels.ts";
import { TargetPicker } from "./target-picker.tsx";

const SECTION_TITLE = "mb-1.5 text-xs font-medium text-muted";
/** A check box in a small line under a revision or a speaker. */
const SMALL_CHECK_LABEL = "gap-1.5! text-xs! mt-0.5";
const BADGE: Record<string, string> = {
  new: "bg-accent-soft text-accent",
  existing: "bg-sunken text-muted",
  differs: "bg-danger/10 text-danger",
  conflict: "bg-danger/10 text-danger",
  fill: "bg-accent-soft text-accent",
};

/**
 * The import preview: one line of conclusion per carried Content with what it would change,
 * the collections below, totals and 「开始导入」 at the foot. Details open by themselves only
 * where something needs the user or will not go in as is; any row opens on request.
 */
export function ImportPreview(props: {
  job: ContentPackImportJobDto;
  preview: ContentPackPreviewDto;
  onDiscard: () => void;
  discarding: boolean;
  onCommitted: (job: ContentPackImportJobDto) => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const desktop = useDesktop();
  const { preview } = props;
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ContentDraft>>(() => new Map(preview.contents.map((item) => [item.key, initialDraft(item)])));
  const [collections, setCollections] = useState<ReadonlyMap<string, CollectionDraft>>(() => new Map(preview.collections.map((item) => [item.key, initialCollectionDraft(item)])));
  // Rows that show their details: those that need the user when the preview opens or after a
  // change, and those opened by hand. A row never folds by itself, so a control the user is
  // working with stays where it is.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(preview.contents.filter((item) => needsAttention(item, initialDraft(item))).map((item) => item.key)));
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const draftOf = (item: PackPreviewContent): ContentDraft => drafts.get(item.key) ?? initialDraft(item);
  const update = (item: PackPreviewContent, draft: ContentDraft): void => {
    setDrafts((current) => new Map(current).set(item.key, draft));
    if (needsAttention(item, draft)) setOpened((current) => (current.has(item.key) ? current : new Set(current).add(item.key)));
  };
  const problems = blockingProblems(preview, drafts);
  const sum = totals(preview, drafts);
  const shared = useMemo(() => sharedMatches(preview), [preview]);
  const clashes = clashingTargets(preview, drafts);
  const titleByKey = new Map(preview.contents.map((item) => [item.key, titleOf(item.title, t)]));
  const othersOf = (keys: readonly string[]): string => keys.map((key) => t("contentPack.quoted", { text: titleByKey.get(key) ?? "" })).join(t("contentPack.listSeparator"));

  const commit = useMutation({
    mutationFn: async (): Promise<ContentPackImportJobDto | undefined> => {
      setNotice(undefined);
      const decisions = buildDecisions(preview, drafts, collections);
      if (desktop && needsOriginalsDir(preview, drafts)) {
        // The grant lives a few minutes, so the directory is asked for only now.
        let picked;
        try {
          picked = await pickPackOriginalsDir(localTimeStamp(new Date()));
        } catch (error) {
          setNotice(t("contentPack.import.shellRefused", { reason: error instanceof Error ? error.message : String(error) }));
          return undefined;
        }
        if (picked === null) {
          setNotice(t("contentPack.import.originalsCancelled"));
          return undefined;
        }
        return commitImport(client, props.job.jobId, { ...decisions, originalsDir: picked.grant });
      }
      return commitImport(client, props.job.jobId, decisions);
    },
    onSuccess: (job) => {
      if (job !== undefined) props.onCommitted(job);
    },
  });

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="pack-import-preview">
      <div className="text-xs text-muted">
        <p>
          {t("contentPack.import.pack", {
            time: formatDateTime(preview.pack.createdAt, i18n.language),
            version: preview.pack.amberVersion,
            size: bytesLabel(preview.pack.sizeBytes),
          })}
        </p>
        {props.job.expiresAt === undefined ? null : <p data-testid="pack-import-expires">{t("contentPack.import.expires", { time: formatDateTime(props.job.expiresAt, i18n.language) })}</p>}
      </div>

      <section>
        <h3 className={SECTION_TITLE}>{t("contentPack.import.contentsTitle")}</h3>
        <ul className="flex flex-col gap-2">
          {preview.contents.map((item) => {
            const draft = draftOf(item);
            const open = opened.has(item.key);
            const share = shared.get(item.key);
            const clash = clashes.get(item.key);
            return (
              <ContentRow
                key={item.key}
                jobId={props.job.jobId}
                item={item}
                draft={draft}
                open={open}
                shared={share === undefined ? undefined : { title: share.title, others: othersOf(share.otherKeys) }}
                clash={clash === undefined ? undefined : { others: othersOf(clash.otherKeys) }}
                onToggle={() =>
                  setOpened((current) => {
                    const next = new Set(current);
                    if (open) next.delete(item.key);
                    else next.add(item.key);
                    return next;
                  })
                }
                onChange={(next) => update(item, next)}
              />
            );
          })}
        </ul>
      </section>

      {preview.collections.length === 0 ? null : (
        <section data-testid="pack-import-collections">
          <h3 className={SECTION_TITLE}>{t("contentPack.import.collectionsTitle")}</h3>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {preview.collections.map((collection) => (
              <CollectionRow
                key={collection.key}
                collection={collection}
                draft={collections.get(collection.key) ?? initialCollectionDraft(collection)}
                usable={collectionUsable(collection, preview, drafts)}
                onChange={(draft) => setCollections((current) => new Map(current).set(collection.key, draft))}
              />
            ))}
          </ul>
        </section>
      )}

      {needsOriginalsDir(preview, drafts) && desktop ? <InlineNote>{t("contentPack.import.originalsDir")}</InlineNote> : null}
      {notice === undefined ? null : <InlineNote role="status">{notice}</InlineNote>}
      {commit.error === null ? null : <CommitError error={appErrorOf(commit.error)} />}

      <PackFooter
        status={
          <div aria-live="polite" data-testid="pack-import-totals">
            <p>
            {[
              sum.create > 0 ? t("contentPack.import.totals.create", { count: sum.create }) : "",
              sum.merge > 0 ? t("contentPack.import.totals.merge", { count: sum.merge }) : "",
              sum.skip > 0 ? t("contentPack.import.totals.skip", { count: sum.skip }) : "",
              sum.mediaBytes > 0 ? t("contentPack.import.totals.media", { size: bytesLabel(sum.mediaBytes) }) : "",
            ]
              .filter((part) => part !== "")
              .join(t("contentPack.separator"))}
            </p>
            {problems.choose > 0 ? <p className="text-danger">{t("contentPack.import.blocked.choose", { count: problems.choose })}</p> : null}
            {problems.overLimit > 0 ? <p className="text-danger">{t("contentPack.import.blocked.overLimit", { count: problems.overLimit })}</p> : null}
            {problems.sameTarget > 0 ? <p className="text-danger">{t("contentPack.import.blocked.sameTarget", { count: problems.sameTarget })}</p> : null}
            {problems.nothing ? <p className="text-danger">{t("contentPack.import.blocked.nothing")}</p> : null}
          </div>
        }
      >
        <Button loading={props.discarding} disabled={commit.isPending} onClick={props.onDiscard} data-testid="pack-import-discard">
          {t("contentPack.import.cancelImport")}
        </Button>
        <Button variant="primary" loading={commit.isPending} disabled={!canStart(problems)} onClick={() => commit.mutate()} data-testid="pack-import-start">
          {t("contentPack.import.start")}
        </Button>
      </PackFooter>
    </div>
  );
}

function CommitError(props: { error: AppError }) {
  const { t } = useTranslation();
  if (props.error.code === "conflict.pack_job_active") {
    return (
      <Callout tone="warn" announce="alert">
        {t("contentPack.import.jobBusy")}
      </Callout>
    );
  }
  return <ErrorView error={props.error} />;
}

/** The words of a row's conclusion. */
function useConclusionText(): (item: PackPreviewContent, draft: ContentDraft, shared: { title: string | undefined } | undefined) => string {
  const { t } = useTranslation();
  return (item, draft, shared) => {
    const conclusion = conclusionOf(item, draft, shared);
    switch (conclusion.kind) {
      case "merge":
      case "mergeMedia":
      case "mergeOther":
      case "shared":
        return t(`contentPack.import.conclusion.${conclusion.kind}`, { title: titleOf(conclusion.title, t) });
      case "choose":
        return t("contentPack.import.conclusion.choose", { count: conclusion.count });
      default:
        return t(`contentPack.import.conclusion.${conclusion.kind}`);
    }
  };
}

/** 「新增字幕 2 份 · 新增插图 3 张 · 本机不同 1 项」. */
function useChangeText(): (draft: ContentDraft) => string {
  const { t } = useTranslation();
  return (draft) => {
    const summary = changeSummary(draft);
    const parts: string[] = [];
    if (summary.revisions > 0) parts.push(t("contentPack.import.change.revisions", { count: summary.revisions }));
    if (summary.speakers > 0) parts.push(t("contentPack.import.change.speakers", { count: summary.speakers }));
    if (summary.figures > 0) parts.push(t("contentPack.import.change.figures", { count: summary.figures }));
    if (summary.notes > 0) parts.push(t("contentPack.import.change.notes", { count: summary.notes }));
    if (summary.media > 0) parts.push(t("contentPack.import.change.media", { count: summary.media }));
    if (summary.differs > 0) parts.push(t("contentPack.import.change.differs", { count: summary.differs }));
    if (summary.conflicts > 0) parts.push(t("contentPack.import.change.conflicts", { count: summary.conflicts }));
    if (parts.length === 0) return summary.existing > 0 ? t("contentPack.import.change.existing") : t("contentPack.import.change.nothing");
    return parts.join(t("contentPack.separator"));
  };
}

type ActionValue = "" | "import" | "merge" | "skip";

function ContentRow(props: {
  jobId: string;
  item: PackPreviewContent;
  draft: ContentDraft;
  open: boolean;
  /** Other rows match the same local Content as this one: the titles of those rows and of that Content. */
  shared: { title: string | undefined; others: string } | undefined;
  /** Other rows merge into this row's target too. */
  clash: { others: string } | undefined;
  onToggle: () => void;
  onChange: (draft: ContentDraft) => void;
}) {
  const { t } = useTranslation();
  const { item, draft } = props;
  const detailsId = useId();
  const conclusion = useConclusionText();
  const changes = useChangeText();
  const title = titleOf(item.title, t);
  const trashed = item.match === "trashed";
  const candidates = decidingCandidates(item).filter((candidate) => !candidate.trashed);
  const suggested = item.diff.targetContentId;
  const asNew = canImportAsNew(item);
  const acting = draft.action === "import" || draft.action === "merge";
  const attention = !trashed && draft.action !== "skip" && (draft.action === undefined || blockingOverLimit(draft).length > 0 || props.clash !== undefined);
  const value: ActionValue = draft.action ?? "";

  const choose = (next: ActionValue): void => {
    if (next === "skip") props.onChange({ ...draft, action: "skip" });
    else if (next === "import") props.onChange(draftFor(item.match === "new" ? item.diff : { ...emptyDiffLike(item.diff) }, "import"));
    else if (next === "merge") {
      // Back to the suggested target (or the target picked before) with its own diff.
      if (draft.action === "skip" && draft.targetContentId !== undefined) props.onChange({ ...draft, action: "merge" });
      else if (suggested !== undefined) props.onChange(draftFor(item.diff, "merge"));
    }
  };

  return (
    <li className={`rounded-lg border ${attention ? "border-accent/60" : "border-line"}`} data-testid="pack-import-row" data-key={item.key} data-match={item.match}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate font-medium" title={title}>
            {title}
          </p>
          <p className="text-xs text-muted">{sourceLine(item.sourceKind, item.durationMs, t)}</p>
          <p className={`mt-1 ${trashed || draft.action === undefined ? "font-medium" : ""}`} data-testid="pack-import-conclusion">
            {conclusion(item, draft, props.shared)}
            {trashed ? (
              <>
                {" "}
                <Link to="/trash" className={`text-note font-normal ${TEXT_ACTION_CLASS}`}>
                  {t("contentPack.import.trashLink")}
                </Link>
              </>
            ) : null}
          </p>
          {acting ? (
            <p className="text-xs text-muted" data-testid="pack-import-changes">
              {changes(draft)}
            </p>
          ) : null}
          {props.shared !== undefined && !trashed && draft.action === undefined ? (
            <InlineNote className="mt-1.5" testId="pack-import-shared">
              {t("contentPack.import.shared", { others: props.shared.others, title: titleOf(props.shared.title, t) })}
            </InlineNote>
          ) : null}
          {props.clash !== undefined ? (
            <Callout tone="error" density="compact" announce="alert" className="mt-1.5" testId="pack-import-same-target">
              {t("contentPack.import.sameTarget", { others: props.clash.others, title: targetTitle(item, draft, t) })}
            </Callout>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <NativeSelect
            size="md"
            className="max-w-56"
            aria-label={t("contentPack.import.action.label", { title })}
            value={trashed ? "skip" : value}
            disabled={trashed}
            onChange={(event) => choose(event.target.value as ActionValue)}
            data-testid="pack-import-action"
          >
            {draft.action === undefined ? (
              <option value="" disabled>
                {t("contentPack.import.action.choose")}
              </option>
            ) : null}
            {item.match === "new" ? <option value="import">{t("contentPack.import.action.import")}</option> : null}
            {item.match === "same" || item.match === "same_media" ? (
              <option value="merge" disabled={suggested === undefined && draft.targetContentId === undefined}>
                {t("contentPack.import.action.merge")}
              </option>
            ) : null}
            {/* The conclusion beside it names the target; the option stays short in a narrow row. */}
            {item.match === "new" && draft.manualTarget === true ? <option value="merge">{t("contentPack.import.action.merge")}</option> : null}
            {asNew ? <option value="import">{t("contentPack.import.action.importAsNew")}</option> : null}
            <option value="skip">{t("contentPack.import.action.skip")}</option>
          </NativeSelect>
          {trashed ? null : (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-expanded={props.open}
              aria-controls={detailsId}
              aria-label={props.open ? t("contentPack.import.hideDetails", { title }) : t("contentPack.import.showDetails", { title })}
              onClick={props.onToggle}
              data-testid="pack-import-details-toggle"
            >
              <ChevronRight size={14} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${props.open ? "rotate-90" : ""}`} />
              {t("contentPack.import.details")}
            </button>
          )}
        </div>
      </div>
      {props.open && !trashed ? (
        <div id={detailsId} className="flex flex-col gap-4 border-t border-line px-3 py-3" data-testid="pack-import-details">
          <TargetSection jobId={props.jobId} item={item} draft={draft} candidates={candidates} onChange={props.onChange} />
          {acting ? <Details item={item} draft={draft} onChange={props.onChange} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/** A diff of the same carried Content as a new one: nothing here, everything new. The preview only has the diff for its suggested target, so a row turned into a new Content keeps the carried items' list with their states reset. */
function emptyDiffLike(diff: PackContentDiff): PackContentDiff {
  const { targetContentId: _target, targetPrimaryRevisionId: _primary, ...rest } = diff;
  return {
    ...rest,
    revisions: diff.revisions.map((revision) => {
      const { sameTextAs: _same, sameTextAsRevision: _described, ...own } = revision;
      return { ...own, state: "new" as const };
    }),
    speakers: diff.speakers.map((speaker) => {
      const { localSpeakerId: _id, localName: _name, ...own } = speaker;
      return { ...own, state: "new" as const, sameNameCandidates: [] };
    }),
    figures: { new: diff.figures.new + diff.figures.existing + diff.figures.differs, existing: 0, differs: 0, deletedHere: 0, placedByTime: diff.figures.placedByTime },
    notes: { new: diff.notes.new + diff.notes.existing + diff.notes.differs, existing: 0, differs: 0, unplaceable: diff.notes.unplaceable },
    platformChapters: diff.platformChapters === "none" ? "none" : "add",
    media: diff.media.map((media) => ({ ...media, state: "new" as const })),
    overLimit: [],
  };
}

function targetTitle(item: PackPreviewContent, draft: ContentDraft, t: (key: "contentPack.untitled") => string): string {
  if (draft.targetTitle !== undefined) return draft.targetTitle;
  const title = item.candidates.find((candidate) => candidate.contentId === draft.targetContentId)?.title;
  return title === undefined || title.trim() === "" ? t("contentPack.untitled") : title;
}

/** Which local Content the carried one goes into: candidates to pick from, 「合并到其它内容…」, a hand-picked target. */
function TargetSection(props: { jobId: string; item: PackPreviewContent; draft: ContentDraft; candidates: PackPreviewContent["candidates"]; onChange: (draft: ContentDraft) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const { item, draft } = props;
  const [picking, setPicking] = useState(false);
  const name = useId();
  const several = props.candidates.length > 1 || (item.match !== "new" && item.diff.targetContentId === undefined);
  // A candidate other than the suggested one has its own diff; the server compares it.
  const compare = useMutation({
    mutationFn: (contentId: string) => comparePack(client, props.jobId, item.key, contentId),
    onSuccess: (diff) => props.onChange(draftFor(diff, "merge")),
  });
  // The candidate being compared is held in component state, set in the change handler itself: the
  // mutation's pending state reaches React only on a later tick, and a controlled radio whose
  // `checked` has not changed by the end of the event is put back to unchecked.
  const [comparing, setComparing] = useState<string | undefined>(undefined);
  const pendingTarget = comparing ?? (compare.isPending ? compare.variables : undefined);
  const pick = (contentId: string): void => {
    if (contentId === item.diff.targetContentId) {
      props.onChange(draftFor(item.diff, "merge"));
      return;
    }
    setComparing(contentId);
    compare.mutate(contentId, { onSettled: () => setComparing(undefined) });
  };
  const suggested = props.candidates.find((candidate) => candidate.contentId === item.diff.targetContentId);
  const durationWarning = (localMs: number | undefined): ReactNode =>
    durationsDiffer(item.durationMs, localMs, CONTENT_PACK_MERGE_DURATION_WARN_MS) ? (
      <span className="flex items-start gap-1 text-note text-warn">
        <TriangleAlert size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">{t("contentPack.import.mergeOther.durationWarning", { pack: formatDuration(item.durationMs ?? 0), local: formatDuration(localMs ?? 0) })}</span>
      </span>
    ) : null;
  return (
    <div>
      {several ? (
        <fieldset className="min-w-0" data-testid="pack-import-candidates">
          <legend className={SECTION_TITLE}>{t("contentPack.import.candidates.title")}</legend>
          <ul className="flex flex-col gap-1.5">
            {decidingCandidates(item).map((candidate) => (
              <li key={candidate.contentId}>
                <RadioCard
                  name={name}
                  cardClassName="p-2.5"
                  disabled={candidate.trashed || pendingTarget !== undefined}
                  checked={pendingTarget !== undefined ? pendingTarget === candidate.contentId : draft.action === "merge" && draft.targetContentId === candidate.contentId && draft.manualTarget !== true}
                  onChange={() => pick(candidate.contentId)}
                  title={<span className="font-normal break-words">{titleOf(candidate.title, t)}</span>}
                  description={
                    <>
                      {t(`contentPack.import.reason.${candidate.reason}`)}
                      {candidate.durationMs === undefined ? null : `${t("contentPack.separator")}${t("contentPack.import.candidates.duration", { duration: formatDuration(candidate.durationMs) })}`}
                      {candidate.trashed ? `${t("contentPack.separator")}${t("contentPack.import.candidates.trashed")}` : null}
                    </>
                  }
                >
                  {candidate.trashed ? null : durationWarning(candidate.durationMs)}
                </RadioCard>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {!several && suggested !== undefined && draft.manualTarget !== true && draft.action === "merge" ? (
        <p className={NOTE_TEXT_CLASS} data-testid="pack-import-match-reason">
          {t(`contentPack.import.reason.${suggested.reason}`)}
          {suggested.durationMs === undefined ? null : `${t("contentPack.separator")}${t("contentPack.import.candidates.duration", { duration: formatDuration(suggested.durationMs) })}`}
        </p>
      ) : null}
      {draft.manualTarget === true ? (
        <div className="text-sm" data-testid="pack-import-manual-target">
          <span className="font-medium">{t("contentPack.import.conclusion.mergeOther", { title: draft.targetTitle ?? t("contentPack.untitled") })}</span>
          <TextAction className="ml-2" onClick={() => props.onChange(initialDraft(item))}>
            {t("contentPack.import.mergeOther.reset")}
          </TextAction>
          {durationWarning(draft.targetDurationMs)}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setPicking(true)} data-testid="pack-import-merge-other">
          {t("contentPack.import.action.mergeOther")}
        </Button>
        {pendingTarget !== undefined ? <span className="text-xs text-muted">{t("contentPack.import.mergeOther.comparing")}</span> : null}
      </div>
      {compare.error === null ? null : <ErrorView error={appErrorOf(compare.error)} />}
      <TargetPicker
        open={picking}
        onClose={() => setPicking(false)}
        jobId={props.jobId}
        item={item}
        onPicked={(diff, target) => {
          props.onChange(draftFor(diff, "merge", target));
          setPicking(false);
        }}
      />
    </div>
  );
}

function StateBadge(props: { state: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className={`ml-1.5 inline-block rounded px-1 py-0.5 align-middle text-xs whitespace-nowrap ${BADGE[props.state] ?? ""}`}>
      {props.children ?? t(`contentPack.import.state.${props.state}` as "contentPack.import.state.new")}
    </span>
  );
}

/** Everything a carried Content brings, category by category, with its state here and what the user can switch. */
function Details(props: { item: PackPreviewContent; draft: ContentDraft; onChange: (draft: ContentDraft) => void }) {
  const { t, i18n } = useTranslation();
  const { item, draft, onChange } = props;
  const { diff } = draft;
  const [confirmingPrimary, setConfirmingPrimary] = useState<PackRevisionDiff | undefined>(undefined);
  const over = (category: "figures" | "notes" | "speakers") => diff.overLimit.find((entry) => entry.category === category);
  const excluded = new Set(draft.excludeRevisionKeys);
  const toggle = (list: readonly string[], key: string, on: boolean): string[] => (on ? [...list.filter((item) => item !== key), key] : list.filter((item) => item !== key));
  const merging = draft.action === "merge";
  const speakersShown = diff.speakers.filter((speaker) => speaker.state === "differs" || (speaker.state === "new" && speaker.sameNameCandidates.length > 0));
  const adoptable = (draft.notes ? diff.notes.differs : 0) + (draft.figures ? diff.figures.differs : 0);
  const adoptItems: string[] = [];
  if (draft.notes && diff.notes.differs > 0) adoptItems.push(t("contentPack.import.adopt.items.notes", { count: diff.notes.differs }));
  if (draft.figures && diff.figures.differs > 0) adoptItems.push(t("contentPack.import.adopt.items.figures", { count: diff.figures.differs }));
  // Each side's latest change of what differs, as a hint only: the two devices' clocks may disagree.
  const adoptTimes: string[] = [];
  for (const category of ["notes", "figures"] as const) {
    const times = diff[category].differsUpdatedAt;
    if (times === undefined || diff[category].differs === 0 || !draft[category]) continue;
    adoptTimes.push(
      t("contentPack.import.adopt.updatedAt", { category: t(`contentPack.import.adopt.category.${category}`), here: revisionTimeLabel(times.here), pack: revisionTimeLabel(times.pack) }),
    );
  }
  const speakersOver = over("speakers");
  const figuresOver = over("figures");
  const notesOver = over("notes");

  return (
    <>
      {diff.revisions.length === 0 ? null : (
        <fieldset className="min-w-0" data-testid="pack-import-revisions">
          <legend className="sr-only">{t("contentPack.import.category.revisions")}</legend>
          <Checkbox labelClassName={`${CHECK_LABEL} font-medium`} className={CHECK_BOX} checked={draft.revisions} onChange={(event) => onChange({ ...draft, revisions: event.target.checked })} data-testid="pack-import-category-revisions">
            {t("contentPack.import.category.revisions")}
          </Checkbox>
          <ul className={`mt-1.5 flex flex-col gap-1.5 pl-6 ${draft.revisions ? "" : "opacity-60"}`}>
            {diff.revisions.map((revision) => {
              const importable = revision.state === "new" && revision.rejected === undefined;
              const label = packRevisionLabel(revision, t, i18n);
              const included = draft.revisions && importable && !excluded.has(revision.key);
              return (
                <li key={revision.key} data-testid="pack-import-revision" data-state={revision.rejected === undefined ? revision.state : "rejected"}>
                  <div className="flex items-start gap-2 text-sm">
                    {importable ? (
                      <Checkbox
                        className={CHECK_BOX}
                        aria-label={label}
                        checked={included}
                        disabled={!draft.revisions}
                        onChange={(event) => onChange({ ...draft, excludeRevisionKeys: toggle(draft.excludeRevisionKeys, revision.key, !event.target.checked) })}
                      />
                    ) : (
                      <span className="w-4 shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0">
                      <span className="break-words">{label}</span>
                      {revision.rejected === undefined ? <StateBadge state={revision.state === "differs" ? "conflict" : revision.state} /> : <StateBadge state="conflict" />}
                      {revision.archived ? <StateBadge state="existing">{t("contentPack.import.revision.archived")}</StateBadge> : null}
                      {revision.rejected === undefined ? null : <span className="block text-note text-danger">{t("contentPack.import.revision.rejected")}</span>}
                      {revision.state === "differs" ? <span className="block text-note text-muted">{t("contentPack.import.revision.differs")}</span> : null}
                      {revision.standalone && importable ? (
                        <span className="block text-note text-muted">{t("contentPack.import.revision.standalone", { kind: t(`contentView.revisionKind.${revision.originalKind}`) })}</span>
                      ) : null}
                      {revision.sameTextAs === undefined || !importable ? null : (
                        <span className="block text-note text-muted" data-testid="pack-import-same-text">
                          {revision.sameTextAsRevision === undefined
                            ? t("contentPack.import.revision.sameTextUnknown")
                            : t("contentPack.import.revision.sameText", { label: describedRevisionLabel(revision.sameTextAsRevision, t, i18n) })}
                        </span>
                      )}
                      {included && revision.kind === "translated" ? (
                        revision.becomesCurrentTranslation ? (
                          <span className="block text-note text-muted">{t("contentPack.import.revision.becomesCurrent")}</span>
                        ) : (
                          <Checkbox
                            labelClassName={`flex! ${SMALL_CHECK_LABEL}`}
                            checked={draft.currentTranslationKeys.includes(revision.key)}
                            onChange={(event) => onChange({ ...draft, currentTranslationKeys: toggle(draft.currentTranslationKeys, revision.key, event.target.checked) })}
                          >
                            {t("contentPack.import.revision.setCurrentTranslation")}
                          </Checkbox>
                        )
                      ) : null}
                      {included && merging && revision.kind !== "translated" ? (
                        <Checkbox
                          labelClassName={`flex! ${SMALL_CHECK_LABEL}`}
                          title={t("contentPack.import.revision.setPrimaryHint")}
                          checked={draft.setPrimaryRevisionKey === revision.key}
                            onChange={(event) => {
                              if (!event.target.checked) {
                                const { setPrimaryRevisionKey: _cleared, ...rest } = draft;
                                onChange(rest);
                              } else {
                                setConfirmingPrimary(revision);
                              }
                            }}
                          data-testid="pack-import-set-primary"
                        >
                          {t("contentPack.import.revision.setPrimary")}
                        </Checkbox>
                      ) : null}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {speakersOver !== undefined && draft.revisions ? (
            <Callout tone="error" density="compact" announce="alert" className="mt-2" testId="pack-import-over-speakers">
              {t("contentPack.import.overLimit.speakers", { over: speakersOver.over, limit: speakersOver.limit })}
            </Callout>
          ) : null}
        </fieldset>
      )}

      {speakersShown.length === 0 || !draft.revisions ? null : (
        <section data-testid="pack-import-speakers">
          <h4 className={SECTION_TITLE}>{t("contentPack.import.category.speakers")}</h4>
          <ul className="flex flex-col gap-1.5 pl-1">
            {speakersShown.map((speaker) => {
              const name = speaker.name ?? t("contentPack.import.speakers.unnamed", { ordinal: speaker.ordinal });
              if (speaker.state === "differs") {
                return (
                  <li key={speaker.key} className="text-sm">
                    {t("contentPack.import.speakers.differs", { local: speaker.localName ?? name, pack: name })}
                  </li>
                );
              }
              return (
                <li key={speaker.key} className="text-sm">
                  <p>
                    {name}
                    <StateBadge state="new" />
                  </p>
                  {speaker.sameNameCandidates.map((candidate) => (
                    <Checkbox
                      key={candidate.speakerId}
                      labelClassName={`flex! ${SMALL_CHECK_LABEL}`}
                      checked={draft.sameSpeakers[speaker.key] === candidate.speakerId}
                        onChange={(event) => {
                          const next = { ...draft.sameSpeakers };
                          if (event.target.checked) next[speaker.key] = candidate.speakerId;
                          else delete next[speaker.key];
                          onChange({ ...draft, sameSpeakers: next });
                        }}
                      data-testid="pack-import-same-speaker"
                    >
                      {t("contentPack.import.speakers.sameName", { name: candidate.name })}
                    </Checkbox>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {diff.figures.new + diff.figures.existing + diff.figures.differs + diff.figures.deletedHere === 0 ? null : (
        <section data-testid="pack-import-figures">
          <Checkbox labelClassName={`${CHECK_LABEL} font-medium`} className={CHECK_BOX} checked={draft.figures} onChange={(event) => onChange({ ...draft, figures: event.target.checked })} data-testid="pack-import-category-figures">
            {t("contentPack.import.category.figures")}
          </Checkbox>
          <div className={`pl-6 ${NOTE_TEXT_CLASS} ${draft.figures ? "" : "opacity-60"}`}>
            <p>{t("contentPack.import.figures.counts", diff.figures)}</p>
            {diff.figures.placedByTime > 0 ? <p>{t("contentPack.import.figures.placedByTime", { count: diff.figures.placedByTime })}</p> : null}
            {diff.figures.deletedHere > 0 ? <p>{t("contentPack.import.figures.deletedHere", { count: diff.figures.deletedHere })}</p> : null}
          </div>
          {figuresOver !== undefined && draft.figures ? (
            <Callout tone="error" density="compact" announce="alert" className="mt-1.5 ml-6" testId="pack-import-over-figures">
              {t("contentPack.import.overLimit.figures", { over: figuresOver.over, limit: figuresOver.limit })}
            </Callout>
          ) : null}
        </section>
      )}

      {diff.notes.new + diff.notes.existing + diff.notes.differs + diff.notes.unplaceable === 0 ? null : (
        <section data-testid="pack-import-notes">
          <Checkbox labelClassName={`${CHECK_LABEL} font-medium`} className={CHECK_BOX} checked={draft.notes} onChange={(event) => onChange({ ...draft, notes: event.target.checked })} data-testid="pack-import-category-notes">
            {t("contentPack.import.category.notes")}
          </Checkbox>
          <div className={`pl-6 ${NOTE_TEXT_CLASS} ${draft.notes ? "" : "opacity-60"}`}>
            <p>{t("contentPack.import.notes.counts", diff.notes)}</p>
            {diff.notes.unplaceable > 0 ? <p>{t("contentPack.import.notes.unplaceable", { count: diff.notes.unplaceable })}</p> : null}
          </div>
          {notesOver !== undefined && draft.notes ? (
            <Callout tone="error" density="compact" announce="alert" className="mt-1.5 ml-6" testId="pack-import-over-notes">
              {t("contentPack.import.overLimit.notes", { over: notesOver.over, limit: notesOver.limit })}
            </Callout>
          ) : null}
        </section>
      )}

      {adoptable === 0 ? null : (
        <section data-testid="pack-import-adopt">
          <Checkbox labelClassName={CHECK_LABEL} className={CHECK_BOX} checked={draft.adoptPack} onChange={(event) => onChange({ ...draft, adoptPack: event.target.checked })} data-testid="pack-import-adopt-toggle">
            {t("contentPack.import.adopt.label", { items: adoptItems.join(t("contentPack.listSeparator")) })}
          </Checkbox>
          <p className={`mt-1.5 pl-6 ${NOTE_TEXT_CLASS}`}>{t("contentPack.import.adopt.hint")}</p>
          {adoptTimes.length === 0 ? null : (
            <div className={`mt-1 pl-6 ${NOTE_TEXT_CLASS}`} data-testid="pack-import-adopt-times">
              {adoptTimes.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p>{t("contentPack.import.adopt.clockHint")}</p>
            </div>
          )}
        </section>
      )}

      {diff.platformChapters === "none" ? null : <p className={NOTE_TEXT_CLASS}>{t(`contentPack.import.chapters.${diff.platformChapters}`)}</p>}

      {diff.media.length === 0 ? null : (
        <section data-testid="pack-import-media">
          <h4 className={SECTION_TITLE}>{t("contentPack.import.category.media")}</h4>
          <ul className="flex flex-col gap-1.5">
            {diff.media.map((media) => {
              const choosable = media.state === "new" || media.state === "fill";
              return (
                <li key={media.key}>
                  <Checkbox
                    labelClassName={CHECK_LABEL}
                    className={CHECK_BOX}
                    checked={choosable && draft.mediaKeys.includes(media.key)}
                    disabled={!choosable}
                    onChange={(event) => onChange({ ...draft, mediaKeys: toggle(draft.mediaKeys, media.key, event.target.checked) })}
                    data-testid="pack-import-media-item"
                  >
                    <span>
                        {t(`contentPack.export.mediaKind.${media.kind}`)}
                        {media.quality === undefined ? null : `${t("contentPack.separator")}${media.quality}`}
                        {media.displayName === undefined ? null : (
                          <>
                            {t("contentPack.separator")}
                            <span className="break-all">{media.displayName}</span>
                          </>
                        )}
                      </span>
                    <span className="ml-2 font-mono text-xs text-muted">{bytesLabel(media.sizeBytes)}</span>
                    <StateBadge state={media.state} />
                    {media.state === "conflict" ? <span className="block text-note text-muted">{t("contentPack.import.media.conflict")}</span> : null}
                  </Checkbox>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Modal
        open={confirmingPrimary !== undefined}
        onOpenChange={(open) => (open ? undefined : setConfirmingPrimary(undefined))}
        title={t("contentPack.import.revision.confirmPrimaryTitle")}
        footer={
          <>
            <Button onClick={() => setConfirmingPrimary(undefined)}>{t("common.action.cancel")}</Button>
            <Button
              variant="primary"
              disabled={confirmingPrimary === undefined}
              onClick={() => {
                if (confirmingPrimary === undefined) return;
                onChange({ ...draft, setPrimaryRevisionKey: confirmingPrimary.key });
                setConfirmingPrimary(undefined);
              }}
              data-testid="pack-import-confirm-primary-ok"
            >
              {t("contentPack.import.revision.confirmPrimaryAction")}
            </Button>
          </>
        }
      >
        {confirmingPrimary === undefined ? null : (
          <p className="text-sm" data-testid="pack-import-confirm-primary">
            {t("contentPack.import.revision.confirmPrimary", { title: targetTitle(item, draft, t), label: packRevisionLabel(confirmingPrimary, t, i18n) })}
          </p>
        )}
      </Modal>
    </>
  );
}

function CollectionRow(props: { collection: PackPreviewCollection; draft: CollectionDraft; usable: boolean; onChange: (draft: CollectionDraft) => void }) {
  const { t } = useTranslation();
  const { collection, draft } = props;
  const candidate = collection.candidates[0];
  const value = !props.usable ? "skip" : draft.action === "join" && draft.targetCollectionId !== undefined ? `join:${draft.targetCollectionId}` : draft.action;
  const status =
    collection.match === "same" && candidate !== undefined
      ? t("contentPack.import.collection.same", { name: candidate.name })
      : collection.match === "same_name" && candidate !== undefined
        ? t("contentPack.import.collection.sameName", { name: candidate.name })
        : t("contentPack.import.collection.new");
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5" data-testid="pack-import-collection" data-key={collection.key} data-match={collection.match}>
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-medium break-words">{collection.name}</p>
        <p className="text-xs text-muted">{t("contentPack.import.collection.contains", { count: collection.contentKeys.length })}</p>
        <p className="mt-1 text-sm">{props.usable ? status : <span className="text-muted">{t("contentPack.import.collection.allSkipped")}</span>}</p>
        {props.usable && value.startsWith("join:") ? <p className={NOTE_TEXT_CLASS}>{t("contentPack.import.collection.keepsName")}</p> : null}
      </div>
      <NativeSelect
        size="md"
        className="max-w-56"
        aria-label={t("contentPack.import.collection.label", { name: collection.name })}
        value={value}
        disabled={!props.usable}
        onChange={(event) => {
          const next = event.target.value;
          if (next.startsWith("join:")) props.onChange({ action: "join", targetCollectionId: next.slice("join:".length) });
          else props.onChange({ action: next as "create" | "skip" });
        }}
        data-testid="pack-import-collection-action"
      >
        {collection.match === "same" ? null : <option value="create">{t("contentPack.import.collection.create")}</option>}
        {collection.candidates.map((target) => (
          <option key={target.collectionId} value={`join:${target.collectionId}`}>
            {collection.match === "same_name" ? t("contentPack.import.collection.joinSameName", { name: target.name }) : t("contentPack.import.collection.join", { name: target.name })}
          </option>
        ))}
        <option value="skip">{t("contentPack.import.collection.skip")}</option>
      </NativeSelect>
    </li>
  );
}
