import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerDto, SpeakerListDto } from "../../../shared/dto/speaker.ts";
import type { AlignResult } from "../../../shared/speaker-align.ts";
import type { SpeakerReviewState } from "../../../shared/speakers.ts";
import { useOptionalPlayerController } from "../../player/player-controller.tsx";
import { contentKeys } from "./content-data.ts";
import type { SentenceEditorHandle } from "./sentence-editor.tsx";
import {
  applyAlignment,
  assignSpeaker,
  draftKey,
  effectiveSpeakers,
  FILTER_ALL,
  filterVisible,
  mergeSpeaker,
  splitSegment,
  visibleRange,
  type BaseSpeakers,
  type DraftSegment,
  type SpeakerFilter,
  type SplitRequest,
} from "./speaker-draft.ts";
import { useCreateSpeaker } from "./speakers/speaker-data.ts";

/** What one sentence's speaker column shows. */
export interface LeadView {
  speakerId: string | null;
  review: SpeakerReviewState | undefined;
  /** Shown with its name: the first of the sentences on screen that belong to one speaker. */
  showName: boolean;
  selected: boolean;
  /** The one speaker column in the tab order; the others are reached with the arrow keys. */
  tabbable: boolean;
}

const sameView = (a: LeadView, b: LeadView): boolean =>
  a.speakerId === b.speakerId && a.review === b.review && a.showName === b.showName && a.selected === b.selected && a.tabbable === b.tabbable;

/**
 * The speaker columns of every sentence, computed together. A row whose view did not change
 * is the same object as before, so only the columns that did change re-render.
 */
export function leadViews(
  segments: readonly DraftSegment[],
  resolved: ReadonlyArray<string | null>,
  selected: ReadonlySet<string>,
  active: number | undefined,
  visible: ReadonlySet<number> | undefined,
  previous: readonly LeadView[],
): LeadView[] {
  const shows = (index: number): boolean => visible === undefined || visible.has(index);
  let first: number | undefined;
  for (let index = 0; index < segments.length; index += 1) {
    if (shows(index)) {
      first = index;
      break;
    }
  }
  const tabStop = active !== undefined && shows(active) ? active : first;
  const views: LeadView[] = new Array<LeadView>(segments.length);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as DraftSegment;
    const speakerId = resolved[index] ?? null;
    const view: LeadView = {
      speakerId,
      review: segment.speakerReview,
      // Stretches are read among the sentences on screen: a hidden one in between ends them.
      showName: index === 0 || !shows(index - 1) || resolved[index - 1] !== speakerId,
      selected: selected.has(draftKey(segment, index)),
      tabbable: index === tabStop,
    };
    const before = previous[index];
    views[index] = before !== undefined && sameView(before, view) ? before : view;
  }
  return views;
}

/** The columns' views, which each column subscribes to for its own row. */
export class LeadStore {
  private views: readonly LeadView[] = [];
  private readonly listeners = new Set<() => void>();

  current = (): readonly LeadView[] => this.views;

  at = (index: number): LeadView | undefined => this.views[index];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(next: readonly LeadView[]): void {
    if (next.length === this.views.length && next.every((view, index) => view === this.views[index])) return;
    this.views = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The sentences one change of speaker applies to, by key so it survives edits made meanwhile. */
export interface LeadScope {
  kind: "sentence" | "run" | "selection";
  keys: string[];
  /** The sentence whose column the change was made from; focus stays there. */
  origin: number;
  /** The one speaker all of them have now (`null` = unassigned); `undefined` when they differ. */
  common: string | null | undefined;
}

/** What the sentence's own speaker column and split control may ask the editor to do. */
export interface SpeakerEditingActions {
  /**
   * The sentences a change made from this one covers: the selection it is in, else only
   * itself. With `mode: "run"` (asked for explicitly in the menu), its turn: the neighbours of
   * the same speaker that are on screen.
   */
  scope(index: number, mode?: "sentence" | "run"): LeadScope;
  assign(scope: LeadScope, speakerId: string | null): void;
  createAndAssign(scope: LeadScope): void;
  /** A click on the column: with Shift it selects the range from the last one; otherwise it leaves the selection unless it is in it. */
  pointer(index: number, shift: boolean): void;
  /** Shift+arrow: grows or shrinks the selection by one sentence on screen. */
  extend(index: number, delta: 1 | -1): void;
  clearSelection(): void;
  hasSelection(): boolean;
  /** Moves keyboard focus to the column of the next sentence on screen. */
  moveFocus(index: number, delta: 1 | -1): void;
  /** What splitting a sentence knows beyond its text: where the recognizer heard a change, the playhead, who the neighbours are. */
  splitContext(index: number): { changeAtMs: number | undefined; playheadMs: number | undefined; currentSpeakerId: string | null; nextSpeakerId: string | null };
  split(index: number, request: Omit<SplitRequest, "newId">): boolean;
}

export interface SpeakerEditing {
  contentId: string;
  t: TFunction;
  store: LeadStore;
  speakers: ReadonlyMap<string, SpeakerDto>;
  /** The speakers in use, in ordinal order: numbered in the menu, `1`–`9` on the keyboard. */
  current: readonly SpeakerDto[];
  /** The speakers nobody uses: one step further away, in the menu's 「更多发言人」. */
  others: readonly SpeakerDto[];
  actions: SpeakerEditingActions;
}

const EditingContext = createContext<SpeakerEditing | undefined>(undefined);

export function SpeakerEditingProvider(props: { value: SpeakerEditing; children: ReactNode }) {
  return <EditingContext.Provider value={props.value}>{props.children}</EditingContext.Provider>;
}

export function useSpeakerEditingContext(): SpeakerEditing {
  const value = useContext(EditingContext);
  if (value === undefined) throw new Error("SpeakerEditingProvider missing");
  return value;
}

interface Selection {
  keys: ReadonlySet<string>;
  /** The end that stays when the range is extended. */
  anchor: string | undefined;
  /** The end that moves. */
  head: string | undefined;
}

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_SELECTION: Selection = { keys: NO_KEYS, anchor: undefined, head: undefined };

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** The playback position, following the player; `undefined` when the page has no player or it cannot tell. */
export function useEditingPlayhead(): number | undefined {
  const player = useOptionalPlayerController();
  // A new function per render would resubscribe on every render.
  const subscribe = useCallback((listener: () => void) => (player === undefined ? NO_SUBSCRIPTION() : player.subscribe(listener)), [player]);
  return useSyncExternalStore(subscribe, () => player?.currentTimeMs());
}

/** A client-side id for a sentence a split creates; a commit gives every sentence a new id anyway. */
const newSentenceId = (): string => crypto.randomUUID();

/**
 * Speaker editing of the transcript draft: who each sentence reads as, the speaker columns'
 * state and the changes they make, the filter, the selection, splitting a sentence between
 * two speakers and merging two speakers. Every change goes through the editor's undoable
 * batch, so one undo takes back one gesture.
 */
export function useSpeakerEditing(args: {
  contentId: string;
  segments: readonly DraftSegment[];
  baseSpeakers: BaseSpeakers | undefined;
  speakers: readonly SpeakerDto[];
  handleRef: RefObject<SentenceEditorHandle<DraftSegment> | null>;
}) {
  const { t } = useTranslation();
  const { contentId, segments, baseSpeakers, speakers, handleRef } = args;
  const queryClient = useQueryClient();
  const create = useCreateSpeaker(contentId);
  const player = useOptionalPlayerController();
  const [store] = useState(() => new LeadStore());
  const [filter, setFilterState] = useState<SpeakerFilter>(FILTER_ALL);
  const [changedKeys, setChangedKeys] = useState<ReadonlySet<string>>(NO_KEYS);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [active, setActive] = useState<number | undefined>(undefined);
  const [summary, setSummary] = useState<{ auto: number; needsReview: number; unassigned: number } | undefined>(undefined);
  const wrapper = useRef<HTMLDivElement>(null);
  /** Where the recognizer heard the speaker change inside a sentence needing review, by sentence key. */
  const changeAt = useRef(new Map<string, number>());
  /** The draft before the last application of speakers: getting it back by undo ends that application's filters. */
  const appliedFrom = useRef<readonly DraftSegment[] | undefined>(undefined);
  /** Where focus goes once the draft this change produced is on screen: a hidden row would drop it. */
  const pendingFocus = useRef<{ next: readonly DraftSegment[]; target: { lead: number } | { sentence: string } } | undefined>(undefined);

  const resolved = useMemo(() => effectiveSpeakers(segments, baseSpeakers), [segments, baseSpeakers]);
  const visible = useMemo(() => filterVisible(segments, resolved, filter, changedKeys), [segments, resolved, filter, changedKeys]);

  const latest = useRef({ segments, resolved, visible, selection, active, create });
  latest.current = { segments, resolved, visible, selection, active, create };

  // Undoing the application of speakers puts the earlier draft back as the very same array.
  useEffect(() => {
    if (appliedFrom.current !== undefined && segments === appliedFrom.current) {
      appliedFrom.current = undefined;
      changeAt.current = new Map();
      setChangedKeys(NO_KEYS);
      setSummary(undefined);
      setFilterState((now) => (now.kind === "changed" || now.kind === "review" ? FILTER_ALL : now));
    }
  }, [segments]);

  useLayoutEffect(() => {
    store.set(leadViews(segments, resolved, selection.keys, active, visible, store.current()));
  }, [store, segments, resolved, selection.keys, active, visible]);

  // Who is used, as a string: typing changes `resolved` on every key, but the lists below, and
  // the context built from them, must keep their identity then or every column renders again.
  const usedSignature = useMemo(() => [...new Set(resolved.filter((id): id is string => id !== null))].sort().join("\n"), [resolved]);
  const used = useMemo(() => new Set(usedSignature === "" ? [] : usedSignature.split("\n")), [usedSignature]);
  const speakerMap = useMemo(() => new Map(speakers.map((speaker) => [speaker.id, speaker])), [speakers]);
  const drafted = useMemo(() => speakers.filter((speaker) => used.has(speaker.id)), [speakers, used]);
  const rest = useMemo(() => speakers.filter((speaker) => !used.has(speaker.id)), [speakers, used]);
  // The numbered speakers are those somebody uses (the draft or any version), so numbers stay
  // put when a speaker's last sentence moves; the unused ones are one step further away.
  const current = useMemo(() => speakers.filter((speaker) => speaker.used || used.has(speaker.id)), [speakers, used]);
  const others = useMemo(() => speakers.filter((speaker) => !speaker.used && !used.has(speaker.id)), [speakers, used]);

  const actions = useMemo<SpeakerEditingActions>(() => {
    const now = () => latest.current;
    const keyAt = (index: number): string => draftKey(now().segments[index] as DraftSegment, index);
    const indexOfKey = (key: string): number => now().segments.findIndex((segment, index) => draftKey(segment, index) === key);
    const indicesOf = (keys: readonly string[]): number[] => {
      const wanted = new Set(keys);
      const indices: number[] = [];
      now().segments.forEach((segment, index) => {
        if (wanted.has(draftKey(segment, index))) indices.push(index);
      });
      return indices;
    };
    const batch = (next: readonly DraftSegment[], label: string): void => {
      handleRef.current?.applyBatch(next, label);
    };
    /** The nearest sentence on screen in a direction from `index`. */
    const neighbour = (index: number, delta: 1 | -1): number | undefined => {
      const { segments: all, visible: shown } = now();
      for (let at = index + delta; at >= 0 && at < all.length; at += delta) {
        if (shown === undefined || shown.has(at)) return at;
      }
      return undefined;
    };
    const focusLead = (index: number): void => {
      wrapper.current?.querySelector<HTMLElement>(`[data-sentence-index="${index}"] [data-speaker-lead]`)?.focus();
    };
    const assign = (scope: LeadScope, speakerId: string | null): void => {
      const indices = indicesOf(scope.keys);
      const next = assignSpeaker(now().segments, indices, speakerId);
      if (next === now().segments) return;
      pendingFocus.current = { next, target: { lead: scope.origin } };
      batch(next, t("speakerEditor.undo.assign", { count: indices.length }));
    };
    return {
      scope(index, mode) {
        const { segments: all, resolved: speakersOf, selection: picked, visible: shown } = now();
        const key = keyAt(index);
        const onScreen = (at: number): boolean => shown === undefined || shown.has(at);
        const commonOf = (indices: readonly number[]): string | null | undefined => {
          const first = speakersOf[indices[0] ?? index] ?? null;
          return indices.every((at) => (speakersOf[at] ?? null) === first) ? first : undefined;
        };
        if (picked.keys.size > 1 && picked.keys.has(key)) {
          // Only what is on screen: a selection can outlive the change that took rows off it.
          const indices = all.flatMap((segment, at) => (onScreen(at) && picked.keys.has(draftKey(segment, at)) ? [at] : []));
          return { kind: "selection", keys: indices.map(keyAt), origin: index, common: commonOf(indices) };
        }
        if (mode === "run") {
          // A turn is the neighbours of one speaker that are on screen, no hidden sentence in between.
          const speaker = speakersOf[index] ?? null;
          let start = index;
          let end = index;
          while (start > 0 && onScreen(start - 1) && (speakersOf[start - 1] ?? null) === speaker) start -= 1;
          while (end < all.length - 1 && onScreen(end + 1) && (speakersOf[end + 1] ?? null) === speaker) end += 1;
          if (end > start) {
            const indices = Array.from({ length: end - start + 1 }, (_, at) => start + at);
            return { kind: "run", keys: indices.map(keyAt), origin: index, common: speaker };
          }
        }
        return { kind: "sentence", keys: [key], origin: index, common: speakersOf[index] ?? null };
      },
      assign,
      createAndAssign(scope) {
        void (async () => {
          try {
            const speaker = await now().create.mutateAsync({});
            // Shown at once; the refetch the creation triggers brings the server's view.
            queryClient.setQueryData<SpeakerListDto>(contentKeys.speakers(contentId), (list) => ({ items: [...(list?.items.filter((item) => item.id !== speaker.id) ?? []), { ...speaker, used: true }] }));
            assign(scope, speaker.id);
          } catch {
            // The failure is shown by the editor's notices (`createError`).
          }
        })();
      },
      pointer(index, shift) {
        const { selection: picked, active: last } = now();
        const key = keyAt(index);
        if (shift) {
          const anchorIndex = picked.anchor === undefined ? (last ?? index) : indexOfKey(picked.anchor);
          const range = visibleRange(anchorIndex < 0 ? index : anchorIndex, index, now().visible, now().segments.length);
          setSelection({ keys: new Set(range.map(keyAt)), anchor: keyAt(anchorIndex < 0 ? index : anchorIndex), head: key });
        } else if (!picked.keys.has(key)) {
          setSelection({ keys: NO_KEYS, anchor: key, head: key });
        }
      },
      extend(index, delta) {
        const { selection: picked } = now();
        const anchorIndex = picked.keys.size > 0 && picked.anchor !== undefined ? indexOfKey(picked.anchor) : -1;
        const anchor = anchorIndex < 0 ? index : anchorIndex;
        const headIndex = picked.keys.size > 0 && picked.head !== undefined ? indexOfKey(picked.head) : index;
        const next = neighbour(headIndex < 0 ? index : headIndex, delta);
        if (next === undefined) return;
        setSelection({ keys: new Set(visibleRange(anchor, next, now().visible, now().segments.length).map(keyAt)), anchor: keyAt(anchor), head: keyAt(next) });
        focusLead(next);
      },
      clearSelection: () => setSelection(NO_SELECTION),
      hasSelection: () => now().selection.keys.size > 0,
      moveFocus(index, delta) {
        const next = neighbour(index, delta);
        if (next !== undefined) focusLead(next);
      },
      splitContext(index) {
        const { resolved: speakersOf, segments: all } = now();
        return {
          // The recognizer's change point belongs to a sentence still waiting for review; one
          // that was confirmed, or a draft loaded afresh, has none.
          changeAtMs: all[index]?.speakerReview === "needs_review" ? changeAt.current.get(keyAt(index)) : undefined,
          playheadMs: player?.currentTimeMs(),
          currentSpeakerId: speakersOf[index] ?? null,
          nextSpeakerId: speakersOf[index + 1] ?? null,
        };
      },
      split(index, request) {
        const done = splitSegment(now().segments, index, { ...request, newId: newSentenceId });
        if (done === undefined) return false;
        const original = keyAt(index);
        changeAt.current.delete(original);
        // Both halves are what the application of speakers changed, if the sentence was.
        setChangedKeys((keys) => (keys.has(original) ? new Set([...keys, done.rightKey]) : keys));
        pendingFocus.current = { next: done.segments, target: { sentence: done.rightKey } };
        batch(done.segments, t("speakerEditor.undo.split"));
        return true;
      },
    };
  }, [contentId, handleRef, player, queryClient, t]);

  // Focus follows a change that took the focused row off the screen (a filter) or made a new one.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === undefined || segments !== pending.next) return;
    pendingFocus.current = undefined;
    if ("sentence" in pending.target) {
      const at = segments.findIndex((segment, index) => draftKey(segment, index) === (pending.target as { sentence: string }).sentence);
      if (at >= 0) handleRef.current?.focusSentence(at);
      return;
    }
    const from = pending.target.lead;
    let target: number | undefined;
    for (let index = from; index < segments.length && target === undefined; index += 1) {
      if (visible === undefined || visible.has(index)) target = index;
    }
    for (let index = from - 1; index >= 0 && target === undefined; index -= 1) {
      if (visible === undefined || visible.has(index)) target = index;
    }
    if (target === undefined) return;
    const lead = wrapper.current?.querySelector<HTMLElement>(`[data-sentence-index="${target}"] [data-speaker-lead]`);
    if (lead !== null && lead !== undefined && document.activeElement !== lead) lead.focus();
  }, [segments, visible, handleRef]);

  const contextValue = useMemo<SpeakerEditing>(
    () => ({ contentId, t, store, speakers: speakerMap, current, others, actions }),
    [contentId, t, store, speakerMap, current, others, actions],
  );

  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-sentence-index]") : null;
    const index = row === null ? Number.NaN : Number(row.dataset["sentenceIndex"]);
    if (Number.isInteger(index)) setActive(index);
  }, []);

  /** Gives every sentence of `from` to `to` as one undoable step. */
  const merge = useCallback(
    (from: string, to: string): void => {
      const { segments: all, resolved: speakersOf } = latest.current;
      const next = mergeSpeaker(all, speakersOf, from, to);
      if (next !== all) handleRef.current?.applyBatch(next, t("speakerEditor.undo.merge"));
    },
    [handleRef, t],
  );

  /** Writes an alignment (computed over this very draft) as one undoable step and filters to what needs confirming. */
  const applyAligned = useCallback(
    (alignment: AlignResult): boolean => {
      const { segments: all, resolved: speakersOf } = latest.current;
      if (alignment.sentences.length !== all.length) return false;
      const applied = applyAlignment(all, speakersOf, alignment.sentences);
      appliedFrom.current = all;
      changeAt.current = applied.changeAt;
      setChangedKeys(applied.changedKeys);
      setSelection(NO_SELECTION);
      setFilterState(applied.reviewCount > 0 ? { kind: "review" } : FILTER_ALL);
      // What the draft now holds, so the line agrees with the filter's count.
      setSummary({ auto: applied.autoCount, needsReview: applied.reviewCount, unassigned: all.length - applied.autoCount - applied.reviewCount });
      handleRef.current?.applyBatch(applied.segments, t("speakerEditor.undo.apply"));
      return true;
    },
    [handleRef, t],
  );

  /** Choosing another set of sentences to show drops the selection: it could name sentences now out of sight. */
  const setFilter = useCallback((next: SpeakerFilter) => {
    setSelection(NO_SELECTION);
    setFilterState(next);
  }, []);
  const dismissSummary = useCallback(() => setSummary(undefined), []);

  return {
    resolved,
    visible,
    drafted,
    rest,
    filter,
    setFilter,
    changedKeys,
    selectedCount: selection.keys.size,
    clearSelection: actions.clearSelection,
    contextValue,
    wrapper,
    onFocus,
    merge,
    applyAligned,
    summary,
    dismissSummary,
    createError: create.error,
  };
}
