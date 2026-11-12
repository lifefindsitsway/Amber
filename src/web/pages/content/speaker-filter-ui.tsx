import { UsersRound } from "lucide-react";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyState } from "../../ui/feedback.tsx";
import { normalizeSelection, paramsWithSelection, rowIndexOfSegment, SPEAKER_PARAM, skippedParts, type FilteredRow, type FilterSpeaker, type GapRow } from "./speaker-filter.ts";
import { SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerLabel } from "./speakers/speaker-data.ts";

/** The reading view's speaker filter as kept in the address (`?speaker=` once per speaker). */
export interface SpeakerFilterState {
  /** Normalized: known speakers once each, by ordinal. */
  selected: string[];
  selectedSet: ReadonlySet<string>;
  active: boolean;
  set: (ids: readonly string[]) => void;
  clear: () => void;
}

/**
 * The speaker filter of the address. Once the Content's speakers are known (`speakers`), an
 * address with unknown, repeated or out-of-order ids is rewritten in place to its normalized
 * form; until then the ids are taken as they are, so a selection is never dropped for a list
 * that has not arrived. Every other parameter is left alone.
 */
export function useSpeakerFilter(speakers: readonly FilterSpeaker[] | undefined): SpeakerFilterState {
  const [params, setParams] = useSearchParams();
  const raw = params.getAll(SPEAKER_PARAM);
  const rawKey = raw.join(",");
  const selected = useMemo(() => {
    const ids = rawKey === "" ? [] : rawKey.split(",");
    return speakers === undefined ? [...new Set(ids)] : normalizeSelection(ids, speakers);
  }, [rawKey, speakers]);
  const selectedKey = selected.join(",");
  useEffect(() => {
    if (speakers !== undefined && rawKey !== selectedKey) setParams((current) => paramsWithSelection(current, selectedKey === "" ? [] : selectedKey.split(","), speakers), { replace: true });
  }, [speakers, rawKey, selectedKey, setParams]);
  const set = useCallback(
    (ids: readonly string[]) => {
      setParams(
        (current) => {
          if (speakers !== undefined) return paramsWithSelection(current, ids, speakers);
          const next = new URLSearchParams(current);
          next.delete(SPEAKER_PARAM);
          for (const id of new Set(ids)) next.append(SPEAKER_PARAM, id);
          return next;
        },
        { replace: true },
      );
    },
    [speakers, setParams],
  );
  const clear = useCallback(() => set([]), [set]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  return { selected, selectedSet, active: selected.length > 0, set, clear };
}

/**
 * The toolbar's 「只看」 icon button and its popover: the revision's speakers (avatar, name,
 * sentence count) as checkboxes, any number of them. A speaker still selected but without
 * sentences here stays listed, so it can be unticked. Filtering happens on the page; nothing
 * is requested.
 */
export function SpeakerFilterButton(props: {
  contentId: string;
  /** The Content's speakers; only those with sentences in `counts`, or selected, are offered. */
  speakers: readonly SpeakerDto[];
  counts: ReadonlyMap<string, number>;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const chosen = new Set(props.selected);
  const offered = [...props.speakers].filter((speaker) => (props.counts.get(speaker.id) ?? 0) > 0 || chosen.has(speaker.id)).sort((a, b) => a.ordinal - b.ordinal);
  const toggle = (id: string): void => props.onChange(chosen.has(id) ? props.selected.filter((item) => item !== id) : [...props.selected, id]);
  const label = props.selected.length === 0 ? t("speakerContext.filter.trigger") : t("speakerContext.filter.triggerActive", { count: props.selected.length });
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger asChild>
        <Button size="sm" variant={props.selected.length === 0 ? "ghost" : "secondary"} aria-label={label} title={label} data-testid="speaker-filter">
          <UsersRound size={14} aria-hidden="true" />
          {props.selected.length === 0 ? null : (
            <span className="tabular-nums" aria-hidden="true">
              {props.selected.length}
            </span>
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={t("speakerContext.filter.trigger")}
          className="z-50 max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-line bg-surface p-2 text-sm text-ink shadow-xl outline-none"
          data-testid="speaker-filter-popover"
        >
          <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted">{t("speakerContext.filter.title")}</p>
          {offered.length === 0 ? (
            <p className="px-2 pb-2 text-xs text-muted">{t("speakerContext.filter.noSpeakers")}</p>
          ) : (
            <ul className="flex flex-col">
              {offered.map((speaker) => {
                const name = speakerLabel(t, speaker);
                const count = props.counts.get(speaker.id) ?? 0;
                return (
                  <li key={speaker.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-sunken" data-testid="speaker-filter-option" data-speaker-id={speaker.id}>
                      <input type="checkbox" checked={chosen.has(speaker.id)} onChange={() => toggle(speaker.id)} />
                      <SpeakerAvatar contentId={props.contentId} speaker={speaker} size={22} decorative />
                      <span className="min-w-0 flex-1 truncate" title={name}>
                        {name}
                      </span>
                      <span className="shrink-0 text-xs text-muted tabular-nums">{t("speakerContext.filter.sentences", { count })}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The selected speakers' names, joined for the active line. */
export function selectedNames(t: Parameters<typeof speakerLabel>[0], speakers: readonly SpeakerDto[], selected: readonly string[]): string {
  const byId = new Map(speakers.map((speaker) => [speaker.id, speaker]));
  return selected.flatMap((id) => {
    const speaker = byId.get(id);
    return speaker === undefined ? [] : [speakerLabel(t, speaker)];
  }).join(t("speakerContext.filter.nameSeparator"));
}

/** 「只看 甲 · N 轮」 and 「清除」 under the toolbar while the filter is on; announced as it changes. */
export function SpeakerFilterBar(props: { speakers: readonly SpeakerDto[]; selected: readonly string[]; turns: number; onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-2 text-xs" data-testid="speaker-filter-bar">
      <span role="status">{t("speakerContext.filter.active", { names: selectedNames(t, props.speakers, props.selected), turns: props.turns })}</span>
      <button type="button" className="text-accent hover:underline" onClick={props.onClear} data-testid="speaker-filter-clear">
        {t("speakerContext.filter.clear")}
      </button>
    </div>
  );
}

/** A skipped stretch in words: 「3 分 20 秒」. */
export function useSkippedText(): (ms: number) => string {
  const { t } = useTranslation();
  return (ms) => {
    const parts = skippedParts(ms);
    switch (parts.unit) {
      case "hours":
        return t("speakerContext.duration.hours", { hours: parts.hours, minutes: parts.minutes });
      case "minutes":
        return t("speakerContext.duration.minutes", { minutes: parts.minutes, seconds: parts.seconds });
      case "seconds":
        return t("speakerContext.duration.seconds", { seconds: parts.seconds });
    }
  };
}

/**
 * The bar between two shown turns that were apart in the full text, saying how long was
 * skipped. Clicking it clears the filter and stays at that place in the full text.
 */
export function SpeakerGap(props: { gap: GapRow; onReturn: (firstSkippedId: string) => void }) {
  const { t } = useTranslation();
  const skipped = useSkippedText();
  const duration = skipped(props.gap.skippedMs);
  return (
    <div className="flex items-center gap-2 py-1.5 pr-2" data-testid="speaker-gap">
      <span className="h-px flex-1 border-t border-dashed border-line" aria-hidden="true" />
      <button
        type="button"
        className="shrink-0 rounded px-2 py-0.5 text-xs text-muted hover:bg-sunken hover:text-ink"
        aria-label={t("speakerContext.filter.gapLabel", { duration })}
        onClick={() => props.onReturn(props.gap.firstSkippedId)}
      >
        {t("speakerContext.filter.gap", { duration })}
      </button>
      <span className="h-px flex-1 border-t border-dashed border-line" aria-hidden="true" />
    </div>
  );
}

/** The selected speakers have no sentence in this revision (say, after switching versions). */
export function SpeakerFilterEmpty(props: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div data-testid="speaker-filter-empty">
      <EmptyState title={t("speakerContext.filter.empty")}>
        <Button size="sm" onClick={props.onClear} data-testid="speaker-filter-empty-clear">
          {t("speakerContext.filter.clearFilter")}
        </Button>
      </EmptyState>
    </div>
  );
}

/**
 * Scrolls the reading view to a sentence once a row shows it: a gap bar clears the filter,
 * and the full text it brings back is only rendered afterwards. `scrollTo` gets the row index
 * in `rows`; the request is dropped once served.
 */
export function useScrollToSegment(rows: readonly FilteredRow[], scrollTo: (index: number) => void): (segmentId: string) => void {
  const [pending, setPending] = useState<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (pending === undefined) return;
    const index = rowIndexOfSegment(rows, pending);
    if (index < 0) return;
    setPending(undefined);
    scrollTo(index);
  }, [pending, rows, scrollTo]);
  return setPending;
}
