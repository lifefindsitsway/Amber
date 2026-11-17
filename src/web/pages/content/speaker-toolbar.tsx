import { ChevronDown, ChevronUp, Combine, ListFilter, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { DropdownMenu, Popover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SPEAKER_PANEL_UNUSED_VISIBLE } from "../../../shared/defaults.ts";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import { speakerShares } from "../../../shared/speaker-turns.ts";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { Button } from "../../ui/button.tsx";
import { MENU_CONTENT_CLASS } from "../../ui/context-menu.tsx";
import { Spinner } from "../../ui/feedback.tsx";
import { contentKeys } from "./content-data.ts";
import { filterCounts, sameFilter, type DraftSegment, type FilterCounts, type SpeakerFilter } from "./speaker-draft.ts";
import { NewSpeakerForm } from "./speakers/new-speaker.tsx";
import { SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerDeleteRefusal, speakerLabel, useDeleteSpeaker, useSpeakers } from "./speakers/speaker-data.ts";
import { shareLine } from "./speakers/speaker-identity-card.tsx";
import { SpeakerEditPopover, SPEAKER_POPOVER_CLASS } from "./speakers/speaker-edit-popover.tsx";

const FILTER_ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-sunken data-[disabled]:cursor-default data-[disabled]:opacity-50";

const formatCount = (value: number, language: string): string => value.toLocaleString(language);

function filterCount(filter: SpeakerFilter, counts: FilterCounts): number {
  switch (filter.kind) {
    case "all":
      return counts.all;
    case "speaker":
      return counts.bySpeaker.get(filter.speakerId) ?? 0;
    case "review":
      return counts.review;
    case "unassigned":
      return counts.unassigned;
    case "changed":
      return counts.changed;
    case "keys":
      return filter.keys.size;
  }
}

/**
 * The filter control of the editor's toolbar: all sentences, one speaker's, those waiting
 * for confirmation, those without a speaker, and those the last application of speakers
 * changed — each with how many. A filter only hides rows; nothing it hides is left out of
 * editing or saving.
 */
export function SpeakerFilterMenu(props: {
  segments: readonly DraftSegment[];
  resolved: ReadonlyArray<string | null>;
  changedKeys: ReadonlySet<string>;
  speakers: readonly SpeakerDto[];
  filter: SpeakerFilter;
  /** What the active filter is called, written on the button so the state is read, not just coloured. */
  filterName: string;
  /** How many sentences the active filter shows. */
  shown: number;
  onFilter: (filter: SpeakerFilter) => void;
  /** Whether sentences were changed by an application of speakers this session. */
  hasChanged: boolean;
}) {
  const { t, i18n } = useTranslation();
  const active = props.filter.kind !== "all";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" className={active ? "bg-accent-soft text-accent" : ""} data-testid="speaker-filter">
          <ListFilter size={14} aria-hidden="true" />
          {active ? t("speakerEditor.filter.active", { filter: props.filterName }) : t("speakerEditor.filter.label")}
          {active ? <span className="font-mono tabular-nums">{formatCount(props.shown, i18n.language)}</span> : null}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={4} collisionPadding={8} className={`${MENU_CONTENT_CLASS} w-60`} data-testid="speaker-filter-menu">
          <FilterEntries {...props} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The menu's entries with their counts; counted when the menu opens, not on every keystroke in the draft. */
function FilterEntries(props: {
  segments: readonly DraftSegment[];
  resolved: ReadonlyArray<string | null>;
  changedKeys: ReadonlySet<string>;
  speakers: readonly SpeakerDto[];
  filter: SpeakerFilter;
  onFilter: (filter: SpeakerFilter) => void;
  hasChanged: boolean;
}) {
  const { t, i18n } = useTranslation();
  const counts = useMemo(() => filterCounts(props.segments, props.resolved, props.changedKeys), [props.segments, props.resolved, props.changedKeys]);
  const named = props.speakers.filter((speaker) => (counts.bySpeaker.get(speaker.id) ?? 0) > 0);
  const entry = (filter: SpeakerFilter, label: string, disabled = false) => {
    const count = filterCount(filter, counts);
    const selected = sameFilter(filter, props.filter);
    return (
      <DropdownMenu.CheckboxItem
        key={filter.kind === "speaker" ? `speaker-${filter.speakerId}` : filter.kind}
        checked={selected}
        disabled={disabled && !selected}
        className={`${FILTER_ITEM_CLASS} data-[state=checked]:font-medium`}
        onSelect={() => props.onFilter(filter)}
        data-testid={`speaker-filter-${filter.kind === "speaker" ? `speaker-${filter.speakerId}` : filter.kind}`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 font-mono text-xs text-muted tabular-nums">{formatCount(count, i18n.language)}</span>
      </DropdownMenu.CheckboxItem>
    );
  };
  return (
    <>
      {entry({ kind: "all" }, t("speakerEditor.filter.all"))}
      <DropdownMenu.Separator className="my-1 h-px bg-line" />
      {named.map((speaker) => entry({ kind: "speaker", speakerId: speaker.id }, speakerLabel(t, speaker)))}
      {named.length > 0 ? <DropdownMenu.Separator className="my-1 h-px bg-line" /> : null}
      {entry({ kind: "review" }, t("speakerEditor.filter.review"), counts.review === 0)}
      {entry({ kind: "unassigned" }, t("speakerEditor.filter.unassigned"), counts.unassigned === 0)}
      {props.hasChanged ? entry({ kind: "changed" }, t("speakerEditor.filter.changed"), counts.changed === 0) : null}
    </>
  );
}

/** Under the toolbar while a filter hides rows: what is shown, how to clear it, and the result of applying speakers. */
export function FilterBar(props: {
  filter: SpeakerFilter;
  label: string;
  shown: number;
  total: number;
  onClear: () => void;
}) {
  const { t, i18n } = useTranslation();
  if (props.filter.kind === "all") return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken/50 px-4 py-1.5 text-xs" role="status" data-testid="speaker-filter-bar">
      <ListFilter size={13} className="shrink-0 text-muted" aria-hidden="true" />
      <span>
        {props.shown === 0
          ? t("speakerEditor.filter.none", { filter: props.label })
          : t("speakerEditor.filter.showing", { filter: props.label, shown: formatCount(props.shown, i18n.language), total: formatCount(props.total, i18n.language) })}
      </span>
      <button type="button" className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent" onClick={props.onClear} data-testid="speaker-filter-clear">
        <X size={12} aria-hidden="true" />
        {t("speakerEditor.filter.clear")}
      </button>
    </div>
  );
}

function SpeakerRow(props: { contentId: string; speaker: SpeakerDto; detail?: ReactNode; children?: ReactNode; below?: ReactNode }) {
  const { t } = useTranslation();
  const label = speakerLabel(t, props.speaker);
  return (
    <li className="px-3 py-1.5" data-testid="speaker-panel-row" data-speaker-id={props.speaker.id}>
      <div className="flex items-center gap-2.5">
        <SpeakerAvatar contentId={props.contentId} speaker={props.speaker} size={28} decorative />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={label} data-testid="speaker-panel-name">
            {label}
          </p>
          {props.detail === undefined || props.detail === "" ? null : <div className="text-xs text-muted tabular-nums">{props.detail}</div>}
        </div>
        <SpeakerEditPopover contentId={props.contentId} speaker={props.speaker} triggerLabel={t("speakerEditor.panel.edit", { name: label })} triggerClassName={ICON_BUTTON_CLASS} testId="speaker-panel-edit">
          <Pencil size={13} aria-hidden="true" />
        </SpeakerEditPopover>
        {props.children}
      </div>
      {props.below}
    </li>
  );
}

/** The small icon buttons of a panel row; the same look as the row's edit trigger. */
const ICON_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

/** The element under `root` whose `data-*` attribute (camel-cased `key`) is exactly `value`, without building a selector from it. */
function byData(root: HTMLElement | null, key: string, value: string): HTMLElement | undefined {
  const attribute = `data-${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
  return Array.from(root?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []).find((element) => element.dataset[key] === value);
}

/** What the undo history of the open editor knows about a speaker. */
export interface SpeakerUndoGuard {
  /** Whether some step that can still be undone involves the speaker. */
  mentions(speakerId: string): boolean;
  /** Drops the steps involving the speaker and every earlier one: undoing them would bring a deleted speaker back. */
  drop(speakerId: string): void;
}

/** The inline confirmation of deleting a speaker, in its row; the focus starts on 「取消」. */
function DeleteConfirm(props: { name: string; warnUndo: boolean; pending: boolean; error: unknown; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("[data-delete-cancel]")?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={box} className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-line bg-sunken/50 px-2.5 py-2" role="group" aria-labelledby={titleId} data-testid="speaker-panel-delete-confirm">
      <p id={titleId} className="text-sm font-medium [overflow-wrap:anywhere]">
        {t("speakerEditor.panel.deleteConfirm", { name: props.name })}
      </p>
      {props.warnUndo ? (
        <p className="text-xs text-danger" data-testid="speaker-panel-delete-undo">
          {t("speakerEditor.panel.deleteUndo")}
        </p>
      ) : null}
      {props.error === null ? null : <ErrorView error={appErrorOf(props.error)} />}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={props.pending} onClick={props.onCancel} data-delete-cancel="" data-testid="speaker-panel-delete-cancel">
          {t("speakerEditor.panel.cancel")}
        </Button>
        <Button size="sm" variant="danger" disabled={props.pending} onClick={props.onConfirm} data-testid="speaker-panel-delete-confirm-button">
          {props.pending ? <Spinner size={12} /> : <Trash2 size={13} aria-hidden="true" />}
          {props.pending ? t("speakerEditor.panel.deleting") : t("speakerEditor.panel.delete")}
        </Button>
      </div>
    </div>
  );
}

/**
 * A speaker of the 「本稿未使用」 group: editable, and deletable (after the inline confirmation)
 * only when nothing refers to it; the line under the name says which it is.
 */
function UnusedSpeakerRow(props: {
  contentId: string;
  speaker: SpeakerDto;
  detail: ReactNode;
  confirming: { warnUndo: boolean } | undefined;
  pending: boolean;
  error: unknown;
  onDelete: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const name = speakerLabel(t, props.speaker);
  const asking = props.confirming !== undefined;
  return (
    <SpeakerRow
      contentId={props.contentId}
      speaker={props.speaker}
      detail={props.detail}
      below={props.confirming === undefined ? null : <DeleteConfirm name={name} warnUndo={props.confirming.warnUndo} pending={props.pending} error={props.error} onConfirm={props.onConfirm} onCancel={props.onCancel} />}
    >
      {/* Referenced by some version or draft: no way to delete, and the line under the name says why. */}
      {props.speaker.referenced ? null : (
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          aria-label={t("speakerEditor.panel.deleteFor", { name })}
          title={t("speakerEditor.panel.delete")}
          aria-expanded={asking}
          disabled={props.pending}
          onClick={props.onDelete}
          data-speaker-delete={props.speaker.id}
          data-testid="speaker-panel-delete"
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      )}
    </SpeakerRow>
  );
}

/**
 * The speaker panel. At the top, fixed while the roster scrolls: the title and 「＋ 新增」, which
 * opens an inline form. 「本稿已使用」: the speakers the draft gives sentences to, with how much
 * they speak, each editable and mergeable into another (in the draft only, undoable); none of
 * them can be deleted. 「本稿未使用」: the rest on offer, editable; one nothing refers to can be
 * deleted after an inline confirmation, one only earlier versions refer to says so instead.
 * Long lists of unused speakers are folded. At the bottom, the way in to applying speakers from
 * a transcript.
 */
export function SpeakerPanel(props: {
  contentId: string;
  segments: readonly DraftSegment[];
  resolved: ReadonlyArray<string | null>;
  /** Speakers the draft uses, in ordinal order. */
  current: readonly SpeakerDto[];
  /** Speakers on offer that the draft does not use. */
  others: readonly SpeakerDto[];
  disabled: boolean;
  /** Whether the editor shows the speaker column; if not, the panel offers to start. */
  columnShown: boolean;
  onStartLabeling: () => void;
  onMerge: (from: string, to: string) => void;
  onApply: () => void;
  /** The editor's undo history: a speaker it involves is deleted only together with those steps. */
  undoGuard?: SpeakerUndoGuard;
  /**
   * Opens the panel, with the focus on its first control, whenever this changes to a new
   * positive value. The value the panel mounts with does not open it.
   */
  openSignal?: number;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showAllUnused, setShowAllUnused] = useState(false);
  const [confirming, setConfirming] = useState<{ speakerId: string; warnUndo: boolean } | undefined>(undefined);
  /** A speaker whose deletion the server refused because something refers to it after all. */
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState("");
  const [reveal, setReveal] = useState<string | undefined>(undefined);
  const content = useRef<HTMLDivElement>(null);
  const addButton = (): HTMLElement | null => content.current?.querySelector<HTMLElement>("[data-speaker-panel-add]") ?? null;
  const remove = useDeleteSpeaker(props.contentId);
  // The full list, comparison-only speakers included: the next ordinal is counted over all of them.
  const all = useSpeakers(props.contentId).data?.items;
  const nextOrdinal = Math.max(0, ...(all ?? [...props.current, ...props.others]).map((speaker) => speaker.ordinal)) + 1;
  const shares = useMemo(
    () => new Map(speakerShares(props.segments.map((segment, index) => ({ startMs: segment.startMs, endMs: segment.endMs, ...(props.resolved[index] == null ? {} : { speakerId: props.resolved[index] as string }) }))).map((share) => [share.speakerId, share])),
    [props.segments, props.resolved],
  );
  const unused = props.others;
  const folded = !showAllUnused && unused.length > SPEAKER_PANEL_UNUSED_VISIBLE;
  const shownUnused = folded ? unused.slice(0, SPEAKER_PANEL_UNUSED_VISIBLE) : unused;

  const lastSignal = useRef(props.openSignal);
  useEffect(() => {
    if (props.openSignal === undefined || props.openSignal <= 0 || props.openSignal === lastSignal.current) return;
    lastSignal.current = props.openSignal;
    changeOpen(true);
  }, [props.openSignal]);

  // A speaker just created (here or elsewhere) is brought into view, unfolding the list for it.
  useEffect(() => {
    if (reveal === undefined) return;
    const at = unused.findIndex((speaker) => speaker.id === reveal);
    if (at >= SPEAKER_PANEL_UNUSED_VISIBLE && !showAllUnused) {
      setShowAllUnused(true);
      return;
    }
    const row = byData(content.current, "speakerId", reveal);
    if (row === undefined) return;
    row.scrollIntoView?.({ block: "nearest" });
    setReveal(undefined);
  }, [reveal, unused, showAllUnused]);

  const changeOpen = (next: boolean): void => {
    setOpen(next);
    // Whether a speaker is still referenced counts the saved draft too, which autosaves without
    // touching the list: read it afresh whenever the panel opens.
    if (next) void queryClient.invalidateQueries({ queryKey: contentKeys.speakers(props.contentId) });
    if (!next) {
      setAdding(false);
      setConfirming(undefined);
      setRefused(undefined);
      setStatus("");
      remove.reset();
    }
  };

  const focusAdd = (): void => {
    requestAnimationFrame(() => addButton()?.focus({ preventScroll: true }));
  };

  const startDelete = (speaker: SpeakerDto): void => {
    remove.reset();
    setRefused(undefined);
    setConfirming({ speakerId: speaker.id, warnUndo: props.undoGuard?.mentions(speaker.id) === true });
  };
  const cancelDelete = (): void => {
    const speakerId = confirming?.speakerId;
    setConfirming(undefined);
    remove.reset();
    if (speakerId !== undefined) requestAnimationFrame(() => byData(content.current, "speakerDelete", speakerId)?.focus({ preventScroll: true }));
  };
  const confirmDelete = (speaker: SpeakerDto): void => {
    const name = speakerLabel(t, speaker);
    const guard = props.undoGuard;
    // Through the promise, not per-call callbacks: closing the panel resets the mutation, which
    // would drop those callbacks, and the undo history must lose the speaker's steps whenever
    // the server did delete it.
    remove.mutateAsync(speaker.id).then(
      () => {
        // Undoing a step that involved the speaker would bring back sentences naming nobody.
        if (guard?.mentions(speaker.id) === true) guard.drop(speaker.id);
        setConfirming(undefined);
        setStatus(t("speakerEditor.panel.deleted", { name }));
        focusAdd();
      },
      (error: unknown) => {
        const refusal = speakerDeleteRefusal(error);
        if (refusal === undefined) return;
        // The list is read again either way; a vanished speaker simply leaves it.
        setConfirming(undefined);
        remove.reset();
        if (refusal === "in_use") setRefused(speaker.id);
        focusAdd();
      },
    );
  };

  const unusedDetail = (speaker: SpeakerDto): ReactNode => {
    if (refused === speaker.id) {
      return (
        <span className="text-danger" role="alert" data-testid="speaker-panel-in-use">
          {t("speakerEditor.panel.inUse")}
        </span>
      );
    }
    return <span data-testid="speaker-panel-detail">{speaker.referenced ? t("speakerEditor.panel.historyOnly") : t("speakerEditor.panel.noSentences")}</span>;
  };

  return (
    <Popover.Root open={open} onOpenChange={changeOpen} modal={false}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" className={open ? "bg-accent-soft text-accent" : ""} data-testid="speaker-panel-toggle">
          <Users size={14} aria-hidden="true" />
          {t("speakerEditor.panel.toggle")}
          {props.current.length > 0 ? <span className="font-mono tabular-nums">{props.current.length}</span> : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className={`${SPEAKER_POPOVER_CLASS} w-[22rem] max-w-[calc(100vw-16px)]`}
          aria-labelledby="speaker-panel-title"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            addButton()?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            // Esc closes what is open inside the panel first; Esc ending an input method's composition is the input method's.
            if (event.isComposing) {
              event.preventDefault();
            } else if (confirming !== undefined && !remove.isPending) {
              event.preventDefault();
              cancelDelete();
            } else if (adding) {
              event.preventDefault();
              setAdding(false);
              focusAdd();
            }
          }}
          data-testid="speaker-panel"
        >
          {/* The header and the footer stay in view; the roster between them scrolls. */}
          <div className="sticky top-0 z-10 border-b border-line bg-surface">
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
              <h2 id="speaker-panel-title" className="min-w-0 flex-1 text-sm font-semibold">
                {t("speakerEditor.panel.title")}
              </h2>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("speakerEditor.panel.addLabel")}
                aria-expanded={adding}
                onClick={() => {
                  setStatus("");
                  setAdding(!adding);
                }}
                data-speaker-panel-add=""
                data-testid="speaker-panel-add"
              >
                <Plus size={14} aria-hidden="true" />
                {t("speakerEditor.panel.add")}
              </Button>
            </div>
            {adding ? (
              <NewSpeakerForm
                contentId={props.contentId}
                nextOrdinal={nextOrdinal}
                onCreated={(speaker) => {
                  setAdding(false);
                  setStatus(t("speakerEditor.panel.created", { name: speakerLabel(t, speaker) }));
                  setReveal(speaker.id);
                  focusAdd();
                }}
                onCancel={() => {
                  setAdding(false);
                  focusAdd();
                }}
              />
            ) : null}
          </div>
          <p className="sr-only" role="status" data-testid="speaker-panel-status">
            {status}
          </p>
          <section className="py-2" aria-labelledby="speaker-panel-used">
            <h3 id="speaker-panel-used" className="px-3 pb-1 text-xs font-medium text-muted">
              {t("speakerEditor.panel.used", { count: props.current.length })}
            </h3>
            {props.current.length === 0 ? (
              <div className="flex flex-col items-start gap-2 px-3 py-1.5">
                <p className="text-xs text-muted">{t("speakerEditor.panel.noneInDraft")}</p>
                {props.columnShown ? null : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={props.disabled}
                    onClick={() => {
                      changeOpen(false);
                      props.onStartLabeling();
                    }}
                    data-testid="speaker-panel-start"
                  >
                    {t("speakerEditor.panel.start")}
                  </Button>
                )}
              </div>
            ) : (
              <ul data-testid="speaker-panel-used">
                {props.current.map((speaker) => {
                  const share = shares.get(speaker.id);
                  const targets = [...props.current.filter((item) => item.id !== speaker.id), ...props.others];
                  return (
                    <SpeakerRow key={speaker.id} contentId={props.contentId} speaker={speaker} detail={shareLine(t, share?.sentences, share?.share)}>
                      <MergeMenu from={speaker} targets={targets} contentId={props.contentId} disabled={props.disabled || targets.length === 0} onMerge={(to) => props.onMerge(speaker.id, to)} />
                    </SpeakerRow>
                  );
                })}
              </ul>
            )}
          </section>
          {unused.length === 0 ? null : (
            <section className="border-t border-line py-2" aria-labelledby="speaker-panel-unused">
              <h3 id="speaker-panel-unused" className="px-3 pb-1 text-xs font-medium text-muted">
                {t("speakerEditor.panel.unused", { count: unused.length })}
              </h3>
              <ul id="speaker-panel-unused-list" data-testid="speaker-panel-unused">
                {shownUnused.map((speaker) => (
                  <UnusedSpeakerRow
                    key={speaker.id}
                    contentId={props.contentId}
                    speaker={speaker}
                    detail={unusedDetail(speaker)}
                    confirming={confirming?.speakerId === speaker.id ? confirming : undefined}
                    pending={remove.isPending}
                    error={remove.error}
                    onDelete={() => (confirming?.speakerId === speaker.id ? cancelDelete() : startDelete(speaker))}
                    onConfirm={() => confirmDelete(speaker)}
                    onCancel={cancelDelete}
                  />
                ))}
              </ul>
              {unused.length > SPEAKER_PANEL_UNUSED_VISIBLE ? (
                <button
                  type="button"
                  aria-expanded={!folded}
                  aria-controls="speaker-panel-unused-list"
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  onClick={() => setShowAllUnused(folded)}
                  data-testid="speaker-panel-more"
                >
                  {folded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}
                  {folded ? t("speakerEditor.panel.showMore", { count: unused.length - SPEAKER_PANEL_UNUSED_VISIBLE }) : t("speakerEditor.panel.showLess")}
                </button>
              ) : null}
            </section>
          )}
          <div className="sticky bottom-0 border-t border-line bg-surface px-3 py-2.5">
            <Button
              size="sm"
              disabled={props.disabled}
              onClick={() => {
                changeOpen(false);
                props.onApply();
              }}
              data-testid="speaker-panel-apply"
            >
              {t("speakerEditor.panel.apply")}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MergeMenu(props: { from: SpeakerDto; targets: readonly SpeakerDto[]; contentId: string; disabled: boolean; onMerge: (to: string) => void }) {
  const { t } = useTranslation();
  const label = speakerLabel(t, props.from);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" disabled={props.disabled} aria-label={t("speakerEditor.panel.mergeFor", { name: label })} className="text-xs" data-testid="speaker-panel-merge">
          <Combine size={13} aria-hidden="true" />
          {t("speakerEditor.panel.merge")}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={4} collisionPadding={8} className={`${MENU_CONTENT_CLASS} max-h-72 w-56 overflow-y-auto`} data-testid="speaker-merge-menu">
          <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">{t("speakerEditor.panel.mergeHint", { name: label })}</DropdownMenu.Label>
          {props.targets.map((target) => (
            <DropdownMenu.Item key={target.id} className={FILTER_ITEM_CLASS} onSelect={() => props.onMerge(target.id)} data-testid={`speaker-merge-to-${target.id}`}>
              <SpeakerAvatar contentId={props.contentId} speaker={target} size={20} decorative />
              <span className="min-w-0 flex-1 truncate">{speakerLabel(t, target)}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
