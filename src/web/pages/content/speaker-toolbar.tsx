import { ChevronDown, ChevronRight, Combine, ListFilter, Pencil, Users, X } from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import { speakerShares } from "../../../shared/speaker-turns.ts";
import { Button } from "../../ui/button.tsx";
import { MENU_CONTENT_CLASS } from "../../ui/context-menu.tsx";
import { filterCounts, sameFilter, type DraftSegment, type FilterCounts, type SpeakerFilter } from "./speaker-draft.ts";
import { SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerLabel } from "./speakers/speaker-data.ts";
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

function SpeakerRow(props: { contentId: string; speaker: SpeakerDto; detail?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const label = speakerLabel(t, props.speaker);
  return (
    <li className="flex items-center gap-2.5 px-3 py-1.5" data-testid="speaker-panel-row" data-speaker-id={props.speaker.id}>
      <SpeakerAvatar contentId={props.contentId} speaker={props.speaker} size={28} decorative />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={label}>
          {label}
        </p>
        {props.detail === undefined || props.detail === "" ? null : <p className="truncate text-xs text-muted tabular-nums">{props.detail}</p>}
      </div>
      <SpeakerEditPopover contentId={props.contentId} speaker={props.speaker} triggerLabel={t("speakerEditor.panel.edit", { name: label })} triggerClassName="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" testId="speaker-panel-edit">
        <Pencil size={13} aria-hidden="true" />
      </SpeakerEditPopover>
      {props.children}
    </li>
  );
}

/**
 * The speaker panel: who is in the draft with how much they speak, each editable and
 * mergeable into another; the Content's other speakers, folded away; a note that AI summary
 * and chat do not read speakers yet; and the way in to applying speakers from a transcript.
 * Merging changes the draft only (and can be undone); the speakers themselves stay.
 */
export function SpeakerPanel(props: {
  contentId: string;
  segments: readonly DraftSegment[];
  resolved: ReadonlyArray<string | null>;
  /** Speakers the draft uses, in ordinal order. */
  current: readonly SpeakerDto[];
  /** Speakers the draft does not use. */
  others: readonly SpeakerDto[];
  disabled: boolean;
  /** Whether the editor shows the speaker column; if not, the panel offers to start. */
  columnShown: boolean;
  onStartLabeling: () => void;
  onMerge: (from: string, to: string) => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const shares = useMemo(
    () => new Map(speakerShares(props.segments.map((segment, index) => ({ startMs: segment.startMs, endMs: segment.endMs, ...(props.resolved[index] == null ? {} : { speakerId: props.resolved[index] as string }) }))).map((share) => [share.speakerId, share])),
    [props.segments, props.resolved],
  );
  // What the server reports unused is what is left to bring back; speakers other revisions use stay out of the way.
  const unused = props.others.filter((speaker) => !speaker.used);
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" className={open ? "bg-accent-soft text-accent" : ""} data-testid="speaker-panel-toggle">
          <Users size={14} aria-hidden="true" />
          {t("speakerEditor.panel.toggle")}
          {props.current.length > 0 ? <span className="font-mono tabular-nums">{props.current.length}</span> : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="end" sideOffset={6} collisionPadding={8} className={`${SPEAKER_POPOVER_CLASS} w-[22rem] max-w-[calc(100vw-16px)]`} aria-label={t("speakerEditor.panel.title")} data-testid="speaker-panel">
          <section className="py-2" aria-labelledby="speaker-panel-current">
            <h3 id="speaker-panel-current" className="px-3 pb-1 text-xs font-medium text-muted">
              {t("speakerEditor.panel.current")}
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
                      setOpen(false);
                      props.onStartLabeling();
                    }}
                    data-testid="speaker-panel-start"
                  >
                    {t("speakerEditor.panel.start")}
                  </Button>
                )}
              </div>
            ) : (
              <ul>
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
            <section className="border-t border-line py-1">
              <button type="button" aria-expanded={showOthers} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" onClick={() => setShowOthers(!showOthers)} data-testid="speaker-panel-others-toggle">
                {showOthers ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                {t("speakerEditor.panel.others", { count: unused.length })}
              </button>
              {showOthers ? (
                <ul data-testid="speaker-panel-others">
                  {unused.map((speaker) => (
                    <SpeakerRow key={speaker.id} contentId={props.contentId} speaker={speaker} />
                  ))}
                </ul>
              ) : null}
            </section>
          )}
          <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
            <p className="text-xs text-muted" data-testid="speaker-panel-note">
              {t("speakerEditor.panel.aiNote")}
            </p>
            <Button
              size="sm"
              disabled={props.disabled}
              onClick={() => {
                setOpen(false);
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
