import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptRevisionListItemDto } from "../../../shared/dto/content.ts";
import { asrDiarizationRecordSchema, type SpeakerDto } from "../../../shared/dto/speaker.ts";
import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { alignSpeakers, type AlignResult } from "../../../shared/speaker-align.ts";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { useSegments } from "./content-data.ts";
import { revisionLabel } from "./labels.ts";
import type { DraftSegment } from "./speaker-draft.ts";
import { draftKey } from "./speaker-draft.ts";
import { SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerLabel } from "./speakers/speaker-data.ts";

/**
 * What a revision's metadata says about speakers: `applied` = recognition identified them,
 * `none` = recognition recorded finding none, `unknown` = nothing recorded (older or not a recognition).
 */
function diarizationStatusOf(revision: TranscriptRevisionListItemDto): "applied" | "none" | "unknown" {
  if (revision.kind !== "asr") return "unknown";
  const record = asrDiarizationRecordSchema.safeParse(revision.generation["diarization"]);
  if (!record.success) return "unknown";
  return record.data.status === "applied" ? "applied" : "none";
}

const RANKS = { applied: 0, unknown: 2, none: 3 } as const;

/** Recognitions that found speakers first, then other recognitions, then the other versions. */
function rankOf(revision: TranscriptRevisionListItemDto): number {
  const status = diarizationStatusOf(revision);
  return status === "unknown" && revision.kind === "asr" ? 1 : RANKS[status];
}

const SELECT_CLASS = "h-8 min-w-0 max-w-full rounded-md border border-line bg-surface px-2 text-sm focus-visible:outline-2 focus-visible:outline-accent";

/** The speakers a revision's sentences name, in order of first appearance, with how many sentences each has. */
export function sourceSpeakers(segments: readonly Pick<TranscriptSegmentDto, "speakerId">[]): Array<{ speakerId: string; sentences: number }> {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    if (segment.speakerId !== undefined) counts.set(segment.speakerId, (counts.get(segment.speakerId) ?? 0) + 1);
  }
  return Array.from(counts, ([speakerId, sentences]) => ({ speakerId, sentences }));
}

/** What an alignment led to, for the summary line. */
export interface AlignmentSummary {
  auto: number;
  needsReview: number;
  unassigned: number;
}

/**
 * The flow of applying one version's speakers to the draft, in one dialog: the source, who
 * each of its speakers is among the Content's identities, and a preview of what would happen
 * to the draft's sentences. 「套用」 hands the alignment to the editor, which writes
 * it as one undoable step; nothing is changed before that.
 */
export function ApplySpeakersDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentId: string;
  /** The revisions of the Content, newest first or not: the dialog orders them. */
  revisions: readonly TranscriptRevisionListItemDto[];
  /** The revision the draft is based on; its own speakers are already in the draft. */
  baseRevisionId: string;
  preselect: string | undefined;
  draft: readonly DraftSegment[];
  /** The draft's speakers per sentence, as the commit will read them. */
  resolved: ReadonlyArray<string | null>;
  speakers: readonly SpeakerDto[];
  onApply: (alignment: AlignResult) => boolean;
}) {
  const { t, i18n } = useTranslation();
  // Which versions to offer comes from their metadata alone: a recognition that recorded
  // finding speakers first, other recognitions next, then the rest; one that recorded finding
  // none is left out. Sentences are read only for the version picked.
  const candidates = useMemo(
    () =>
      props.revisions
        .filter((revision) => revision.kind !== "translated" && revision.archived !== true && revision.id !== props.baseRevisionId && diarizationStatusOf(revision) !== "none")
        .sort((a, b) => rankOf(a) - rankOf(b) || b.createdAt - a.createdAt),
    [props.revisions, props.baseRevisionId],
  );
  const [picked, setPicked] = useState<string | undefined>(props.preselect);
  const wanted = props.preselect === undefined ? undefined : candidates.find((item) => item.id === props.preselect);
  const effective = picked !== undefined && candidates.some((item) => item.id === picked) ? picked : (wanted ?? candidates[0])?.id;
  const loaded = useSegments(props.open ? effective : undefined);
  const segments = loaded.data;
  const source = effective === undefined || segments === undefined ? undefined : { speakers: sourceSpeakers(segments), segments };
  const failure = loaded.isError ? loaded.error : undefined;
  const hasSpeakers = source !== undefined && source.speakers.length > 0;

  const inDraft = useMemo(() => new Set(props.resolved.filter((id): id is string => id !== null)), [props.resolved]);
  const speakerById = useMemo(() => new Map(props.speakers.map((speaker) => [speaker.id, speaker])), [props.speakers]);
  const inDraftSpeakers = props.speakers.filter((speaker) => inDraft.has(speaker.id));
  // The user's choices per source speaker; what is not chosen keeps the source's own identity.
  const [choices, setChoices] = useState<Record<string, string | null>>({});
  useEffect(() => setChoices({}), [effective, props.open]);
  const mapping = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const entry of source?.speakers ?? []) {
      map.set(entry.speakerId, entry.speakerId in choices ? (choices[entry.speakerId] ?? null) : entry.speakerId);
    }
    return map;
  }, [source, choices]);

  const alignment = useMemo(() => {
    if (source === undefined || !props.open) return undefined;
    return alignSpeakers(
      props.draft.map((segment, index) => ({ id: draftKey(segment, index), startMs: segment.startMs, endMs: segment.endMs })),
      source.segments,
      mapping,
    );
  }, [source, mapping, props.draft, props.open]);

  const selectId = useId();
  const revisionName = (revision: TranscriptRevisionListItemDto): string => revisionLabel(revision, undefined, t, i18n, props.revisions);

  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={t("speakerEditor.apply.title")} description={t("speakerEditor.apply.description")} wide>
      <div className="flex flex-col gap-5" data-testid="apply-speakers">
        {candidates.length === 0 ? (
          <p className="text-sm text-muted" data-testid="apply-none">
            {t("speakerEditor.apply.none")}
          </p>
        ) : (
          <section className="flex flex-col gap-1.5" aria-labelledby={`${selectId}-source`}>
            <h3 id={`${selectId}-source`} className="text-xs font-medium text-muted">
              {t("speakerEditor.apply.source")}
            </h3>
            <select className={SELECT_CLASS} value={effective} aria-labelledby={`${selectId}-source`} onChange={(event) => setPicked(event.target.value)} data-testid="apply-source">
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(diarizationStatusOf(item) === "applied" ? "speakerEditor.apply.sourceRecognized" : "speakerEditor.apply.sourceOption", { label: revisionName(item) })}
                </option>
              ))}
            </select>
          </section>
        )}
        {loaded.isPending && effective !== undefined && props.open ? <Loading /> : null}
        {failure === undefined || failure === null ? null : <ErrorView error={appErrorOf(failure)} />}
        {source !== undefined && !hasSpeakers ? (
          <p className="text-sm text-muted" data-testid="apply-no-speakers">
            {t("speakerEditor.apply.noSpeakersIn")}
          </p>
        ) : null}
        {source === undefined || !hasSpeakers ? null : (
          <>
            <section className="flex flex-col gap-1.5" aria-labelledby={`${selectId}-mapping`}>
              <h3 id={`${selectId}-mapping`} className="text-xs font-medium text-muted">
                {t("speakerEditor.apply.mapping")}
              </h3>
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line" data-testid="apply-mapping">
                {source.speakers.map((entry) => {
                  const own = speakerById.get(entry.speakerId);
                  const value = mapping.get(entry.speakerId) ?? null;
                  const ownIsUsed = inDraft.has(entry.speakerId);
                  return (
                    <li key={entry.speakerId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2" data-testid="apply-mapping-row" data-source-speaker={entry.speakerId}>
                      <div className="flex min-w-0 flex-1 items-center gap-2.5 basis-40">
                        {own === undefined ? null : <SpeakerAvatar contentId={props.contentId} speaker={own} size={28} decorative />}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{own === undefined ? t("speakerIdentity.unassigned") : speakerLabel(t, own)}</p>
                          <p className="text-xs text-muted tabular-nums">{t("speakerEditor.apply.sentences", { count: entry.sentences })}</p>
                        </div>
                      </div>
                      <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
                        <span className="shrink-0">{t("speakerEditor.apply.as")}</span>
                        <select
                          className={`${SELECT_CLASS} w-44`}
                          value={value ?? ""}
                          aria-label={t("speakerEditor.apply.mapFor", { name: own === undefined ? entry.speakerId : speakerLabel(t, own) })}
                          onChange={(event) => setChoices({ ...choices, [entry.speakerId]: event.target.value === "" ? null : event.target.value })}
                          data-testid="apply-map"
                        >
                          <option value={entry.speakerId}>{ownIsUsed && own !== undefined ? speakerLabel(t, own) : t("speakerEditor.apply.asNew")}</option>
                          {inDraftSpeakers
                            .filter((speaker) => speaker.id !== entry.speakerId)
                            .map((speaker) => (
                              <option key={speaker.id} value={speaker.id}>
                                {speakerLabel(t, speaker)}
                              </option>
                            ))}
                          <option value="">{t("speakerEditor.apply.nobody")}</option>
                        </select>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="flex flex-col gap-2" aria-labelledby={`${selectId}-preview`}>
              <h3 id={`${selectId}-preview`} className="text-xs font-medium text-muted">
                {t("speakerEditor.apply.preview")}
              </h3>
              {alignment === undefined ? null : (
                <>
                  <p className="text-sm font-medium tabular-nums" role="status" data-testid="apply-summary">
                    {t("speakerEditor.apply.summary", { auto: alignment.auto, needsReview: alignment.needsReview, unassigned: alignment.unassigned })}
                  </p>
                  {alignment.lowCoverage ? (
                    <p className="flex items-start gap-2 rounded-md bg-accent-soft px-3 py-2 text-xs" role="alert" data-testid="apply-low-coverage">
                      <TriangleAlert size={14} className="mt-px shrink-0 text-accent" aria-hidden="true" />
                      <span>{t("speakerEditor.apply.lowCoverage", { percent: Math.round(alignment.coverage * 100) })}</span>
                    </p>
                  ) : null}
                  <p className="text-xs text-muted">{t("speakerEditor.apply.effect")}</p>
                </>
              )}
            </section>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => props.onOpenChange(false)}>{t("common.action.cancel")}</Button>
          <Button
            variant="primary"
            disabled={alignment === undefined || !hasSpeakers}
            onClick={() => {
              if (alignment !== undefined && props.onApply(alignment)) props.onOpenChange(false);
            }}
            data-testid="apply-confirm"
          >
            {t("speakerEditor.apply.confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
