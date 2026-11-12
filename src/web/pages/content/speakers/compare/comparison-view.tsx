import { Play, StepForward, TriangleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptRevisionListItemDto } from "../../../../../shared/dto/content.ts";
import type { SpeakerDto } from "../../../../../shared/dto/speaker.ts";
import type { AttributionDifference, AttributionDifferenceKind, SpeakerCorrespondence } from "../../../../../shared/speaker-compare.ts";
import type { ComparedSentence } from "../../../../../shared/speaker-comparison.ts";
import { appErrorOf } from "../../../../components/confirm-dialog.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { formatDuration } from "../../../../format.ts";
import { Button } from "../../../../ui/button.tsx";
import { Loading } from "../../../../ui/feedback.tsx";
import { useSegments } from "../../content-data.ts";
import { revisionLabel } from "../../labels.ts";
import { SpeakerAvatar } from "../speaker-avatar.tsx";
import { speakerLabel } from "../speaker-data.ts";
import { comparisonCandidates, DIFFERENCE_KINDS, recognitionModel, speakersInOrder, useAttributionComparison } from "./comparison-data.ts";
import { ComparisonTranscribe } from "./comparison-transcribe.tsx";

/** What the editor shows of its rows while a category is picked: only the listed sentences. */
export interface ComparisonFilter {
  kind: AttributionDifferenceKind;
  ids: ReadonlySet<string>;
}

export interface ComparisonViewProps {
  contentId: string;
  durationMs?: number;
  /** The sentences being checked, in display order, with their speakers as the editor resolves them; ids are the editor's row keys. */
  sentences: readonly ComparedSentence[];
  /** The revision the sentences are (drafted from); neither it nor the recognition it comes from is offered as the other side. */
  baseRevisionId: string;
  revisions: readonly TranscriptRevisionListItemDto[];
  /** The Content's speakers, comparison-only ones included: both sides are labelled from this list. */
  speakers: readonly SpeakerDto[];
  /** Plays one sentence's range; without it rows have no play action. */
  playRange?: (startMs: number, endMs: number) => void;
  /** `false` when the player can only seek: the action then reads 「跳到」. */
  rangePlayable?: boolean;
  /** Brings a sentence into view in the editor. */
  onLocate?: (sentenceId: string) => void;
  /** The category picked to filter the editor's rows by; `null` = show every row. */
  onFilterChange?: (filter: ComparisonFilter | null) => void;
  /**
   * The category the editor's rows are filtered by now, when the editor keeps its own filter:
   * `null` = none of the comparison's (every row, or a filter picked elsewhere), which shows
   * 「全部」 as picked. Left out, the picked category is the view's own.
   */
  activeCategory?: AttributionDifferenceKind | null;
}

const SELECT_CLASS = "h-8 min-w-0 max-w-full rounded-md border border-line bg-surface px-2 text-sm focus-visible:outline-2 focus-visible:outline-accent";

const percent = (share: number): number => Math.round(share * 100);

/**
 * Cross-recognition comparison, for the editor's wide area: another transcription of the
 * Content with speakers (usually another vendor's) against the sentences being edited. First
 * whether the two can be compared at all, then who is who (proposed from time overlap, every
 * entry changeable), then the sentences worth a second look in three categories. Read-only:
 * nothing here changes an attribution, the primary or any artifact. Without anything to
 * compare with it offers the paid comparison transcription.
 */
export function ComparisonView(props: ComparisonViewProps) {
  const { t, i18n } = useTranslation();
  const candidates = useMemo(() => comparisonCandidates(props.revisions, props.baseRevisionId), [props.revisions, props.baseRevisionId]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const other = candidates.find((item) => item.id === picked) ?? candidates[0];
  const loaded = useSegments(other?.id);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [kind, setKind] = useState<AttributionDifferenceKind | undefined>(undefined);
  useEffect(() => {
    setOverrides(new Map());
    setKind(undefined);
  }, [other?.id]);
  // A filter picked outside the view replaces its category: the chips must not keep showing
  // one the rows no longer follow, or picking it again would take two presses.
  const { activeCategory } = props;
  useEffect(() => {
    if (activeCategory !== undefined) setKind(activeCategory ?? undefined);
  }, [activeCategory]);
  const result = useAttributionComparison(props.sentences, loaded.data, overrides);
  const speakerById = useMemo(() => new Map(props.speakers.map((speaker) => [speaker.id, speaker])), [props.speakers]);
  const nameOf = (id: string | null): string => {
    const speaker = id === null ? undefined : speakerById.get(id);
    return speaker === undefined ? t("speakerIdentity.unassigned") : speakerLabel(t, speaker);
  };
  const targets = useMemo(() => speakersInOrder(props.sentences), [props.sentences]);
  const sentenceById = useMemo(() => new Map(props.sentences.map((sentence) => [sentence.id, sentence])), [props.sentences]);
  const listed = useMemo(() => (result === undefined ? [] : result.comparison.differences.filter((item) => kind === undefined || item.kind === kind)), [result, kind]);

  const { onFilterChange } = props;
  useEffect(() => {
    if (onFilterChange === undefined) return;
    onFilterChange(kind === undefined || result === undefined ? null : { kind, ids: new Set(result.comparison.differences.filter((item) => item.kind === kind).map((item) => item.segmentId)) });
  }, [kind, result, onFilterChange]);

  const ids = useId();
  const model = other === undefined ? "" : (recognitionModel(other) ?? revisionLabel(other, undefined, t, i18n, props.revisions));

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby={`${ids}-title`} data-testid="comparison-view">
      <header className="flex flex-col gap-1">
        <h2 id={`${ids}-title`} className="text-sm font-semibold">
          {t("speakerCompare.title")}
        </h2>
        <p className="text-xs text-muted">{t("speakerCompare.description")}</p>
      </header>

      {other === undefined ? (
        <div className="flex flex-col gap-3" data-testid="comparison-none">
          <p className="text-sm text-muted">{t("speakerCompare.none")}</p>
          <ComparisonTranscribe contentId={props.contentId} {...(props.durationMs === undefined ? {} : { durationMs: props.durationMs })} />
        </div>
      ) : (
        <>
          {candidates.length > 1 ? (
            <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
              <span>{t("speakerCompare.source")}</span>
              <select className={SELECT_CLASS} value={other.id} onChange={(event) => setPicked(event.target.value)} data-testid="comparison-source">
                {candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {revisionLabel(item, undefined, t, i18n, props.revisions)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {loaded.isPending ? <Loading /> : null}
          {loaded.isError ? <ErrorView error={appErrorOf(loaded.error)} /> : null}
          {result === undefined ? null : (
            <>
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted tabular-nums" data-testid="comparison-header">
                <span>{t("speakerCompare.model", { model })}</span>
                <span>{t("speakerCompare.coverage", { percent: percent(result.comparison.coverage) })}</span>
                {DIFFERENCE_KINDS.map((item) => (
                  <span key={item}>{t("speakerCompare.count", { label: t(`speakerCompare.kind.${item}`), count: result.comparison.counts[item] })}</span>
                ))}
              </p>
              {result.comparison.unreliable ? (
                <p role="alert" className="flex items-start gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm" data-testid="comparison-unreliable">
                  <TriangleAlert size={14} aria-hidden="true" />
                  {t("speakerCompare.unreliable")}
                </p>
              ) : null}

              <Correspondences
                contentId={props.contentId}
                labelledBy={`${ids}-mapping`}
                correspondences={result.correspondences}
                targets={targets}
                speakerById={speakerById}
                nameOf={nameOf}
                onChoose={(sourceId, targetId) => setOverrides(new Map([...overrides, [sourceId, targetId]]))}
              />

              <section className="flex flex-col gap-2" aria-label={t("speakerCompare.filter.label")}>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("speakerCompare.filter.label")} data-testid="comparison-filter">
                  <FilterChip active={kind === undefined} onClick={() => setKind(undefined)} testId="comparison-filter-all">
                    {t("speakerCompare.filter.all", { count: result.comparison.differences.length })}
                  </FilterChip>
                  {DIFFERENCE_KINDS.map((item) => (
                    <FilterChip key={item} active={kind === item} onClick={() => setKind(kind === item ? undefined : item)} testId={`comparison-filter-${item}`}>
                      {t("speakerCompare.count", { label: t(`speakerCompare.kind.${item}`), count: result.comparison.counts[item] })}
                    </FilterChip>
                  ))}
                </div>
                {result.comparison.differences.length === 0 ? (
                  <p className="text-sm text-muted" data-testid="comparison-agree">
                    {t("speakerCompare.agree")}
                  </p>
                ) : listed.length === 0 ? (
                  <p className="text-sm text-muted">{t("speakerCompare.emptyKind")}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-line rounded-md border border-line" data-testid="comparison-list">
                    {listed.map((difference) => (
                      <DifferenceRow
                        key={difference.segmentId}
                        difference={difference}
                        sentence={sentenceById.get(difference.segmentId)}
                        nameOf={nameOf}
                        {...(props.playRange === undefined ? {} : { playRange: props.playRange })}
                        rangePlayable={props.rangePlayable !== false}
                        {...(props.onLocate === undefined ? {} : { onLocate: props.onLocate })}
                      />
                    ))}
                  </ul>
                )}
              </section>
              <p className="text-xs text-muted">{t("speakerCompare.caveat")}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}

function FilterChip(props: { active: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={`h-7 rounded-full border px-2.5 text-xs tabular-nums focus-visible:outline-2 focus-visible:outline-accent ${props.active ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-sunken"}`}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

/** Who each speaker of the other transcription is here: the proposal, its reason, and a dropdown to change it. */
function Correspondences(props: {
  contentId: string;
  labelledBy: string;
  correspondences: readonly SpeakerCorrespondence[];
  targets: readonly string[];
  speakerById: ReadonlyMap<string, SpeakerDto>;
  nameOf: (id: string | null) => string;
  onChoose: (sourceId: string, targetId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-1.5" aria-labelledby={props.labelledBy}>
      <h3 id={props.labelledBy} className="text-xs font-medium text-muted">
        {t("speakerCompare.correspondence.title")}
        <span className="ml-2 font-normal">{t("speakerCompare.correspondence.hint")}</span>
      </h3>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line" data-testid="comparison-mapping">
        {props.correspondences.map((item) => {
          const source = props.speakerById.get(item.sourceId);
          const name = props.nameOf(item.sourceId);
          // A user's choice outside this transcription's speakers still shows as chosen.
          const options = item.targetId === null || props.targets.includes(item.targetId) ? props.targets : [...props.targets, item.targetId];
          return (
            <li key={item.sourceId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2" data-testid="comparison-mapping-row" data-source-speaker={item.sourceId} data-status={item.status}>
              <div className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
                {source === undefined ? null : <SpeakerAvatar contentId={props.contentId} speaker={source} size={24} decorative />}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t("speakerCompare.correspondence.other", { name })}</p>
                  <p className="text-xs text-muted tabular-nums" data-testid="comparison-mapping-status">
                    {t(`speakerCompare.correspondence.status.${item.status}`, { percent: percent(item.share) })}
                  </p>
                </div>
              </div>
              <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="shrink-0">{t("speakerCompare.correspondence.as")}</span>
                <select
                  className={`${SELECT_CLASS} w-44`}
                  value={item.targetId ?? ""}
                  aria-label={t("speakerCompare.correspondence.mapFor", { name })}
                  onChange={(event) => props.onChoose(item.sourceId, event.target.value === "" ? null : event.target.value)}
                  data-testid="comparison-map"
                >
                  {options.map((id) => (
                    <option key={id} value={id}>
                      {props.nameOf(id)}
                    </option>
                  ))}
                  <option value="">{t("speakerCompare.correspondence.nobody")}</option>
                </select>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DifferenceRow(props: {
  difference: AttributionDifference;
  sentence: ComparedSentence | undefined;
  nameOf: (id: string | null) => string;
  playRange?: (startMs: number, endMs: number) => void;
  rangePlayable: boolean;
  onLocate?: (sentenceId: string) => void;
}) {
  const { t } = useTranslation();
  const { difference, sentence } = props;
  const time = sentence === undefined ? "" : formatDuration(sentence.startMs);
  const other =
    difference.kind === "different"
      ? t("speakerCompare.row.other", { name: props.nameOf(difference.otherSpeakerId) })
      : difference.kind === "undetermined"
        ? t("speakerCompare.row.otherUndetermined")
        : t("speakerCompare.row.otherUnmapped");
  const play = props.playRange;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid="comparison-row" data-kind={difference.kind} data-segment-id={difference.segmentId}>
      {props.onLocate === undefined ? (
        <span className="w-14 shrink-0 font-mono text-xs text-muted tabular-nums">{time}</span>
      ) : (
        <button
          type="button"
          className="w-14 shrink-0 text-left font-mono text-xs text-accent tabular-nums hover:underline"
          aria-label={t("speakerCompare.row.locate", { time })}
          onClick={() => props.onLocate?.(difference.segmentId)}
          data-testid="comparison-locate"
        >
          {time}
        </button>
      )}
      <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-xs">{t(`speakerCompare.kind.${difference.kind}`)}</span>
      <span className="min-w-0 flex-1 text-xs">
        {t("speakerCompare.row.current", { name: props.nameOf(difference.speakerId) })}
        <span className="mx-1.5 text-muted" aria-hidden="true">
          ·
        </span>
        {other}
      </span>
      {play === undefined || sentence === undefined ? null : (
        <Button
          size="sm"
          variant="ghost"
          aria-label={t(props.rangePlayable ? "speakerCompare.row.playLabel" : "speakerCompare.row.jumpLabel", { time })}
          onClick={() => play(sentence.startMs, sentence.endMs)}
          data-testid="comparison-play"
        >
          {props.rangePlayable ? <Play size={12} aria-hidden="true" /> : <StepForward size={12} aria-hidden="true" />}
          {t(props.rangePlayable ? "speakerCompare.row.play" : "speakerCompare.row.jump")}
        </Button>
      )}
    </li>
  );
}
