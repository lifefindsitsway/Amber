import { CaseSensitive, ChevronDown, ChevronUp, Replace, Search, Undo2, X } from "lucide-react";
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { DRAFT_BATCH_UNDO_DEPTH } from "../../../shared/defaults.ts";
import { removeSentencesWithParagraphs } from "../../../shared/paragraph-marks.ts";
import { blockedComboOf } from "../../shortcut-registry.tsx";
import { Button, FOCUS_RING } from "../../ui/button.tsx";
import { Checkbox } from "../../ui/checkbox.tsx";
import { Banner, TextAction } from "../../ui/notice.tsx";
import { TextInput } from "../../ui/text-field.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";
import { TwoStepButton } from "../../ui/two-step-button.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import type { InitialScroll, InitialScrollOutcome } from "./edit-position.ts";
import { startInitialScroll } from "./editor-initial-scroll.ts";
import {
  applyDelete,
  applyReplace,
  fillerCandidates,
  fillerCounts,
  findMatches,
  hitContext,
  wholeSentenceFillers,
  type FillerHit,
  type TextMatch,
} from "./find-replace.ts";
import type { DraftSyncSnapshot } from "./use-draft-sync.ts";

/**
 * A sentence the editor can edit: anything with a text. `paragraphStart` is read only by the
 * paragraph rules of whole-sentence deletion; items that never carry it (a translation) are
 * simply removed.
 */
export interface SentenceItem {
  text: string;
  paragraphStart?: boolean;
}

/** One undoable batch: the items before it, and what it did when the caller named it. */
interface UndoEntry<S> {
  items: readonly S[];
  label: string | undefined;
}

/** Combos the editor answers itself while focus is inside it; outside, the browser's own find stays. */
const FIND_COMBOS = new Set(["Ctrl+F", "Meta+F"]);
const REPLACE_COMBOS = new Set(["Ctrl+H", "Meta+H"]);

const matchKey = (match: TextMatch): string => `${match.index}:${match.start}`;

/** Whether a language tag is Chinese, whose drafts get the filler cleanup. */
export function isChineseLanguage(tag: string | undefined): boolean {
  return tag !== undefined && (tag.split("-")[0] ?? "").toLowerCase() === "zh";
}

/**
 * Applies new texts to items: an item whose text did not change is kept as the same object,
 * so an undo snapshot shares it, and `remove` drops whole sentences.
 */
export function withTexts<S extends SentenceItem>(items: readonly S[], texts: readonly string[], remove: ReadonlySet<number> = new Set()): S[] {
  const next: S[] = [];
  items.forEach((item, index) => {
    if (remove.has(index)) return;
    const text = texts[index] ?? item.text;
    next.push(text === item.text ? item : { ...item, text });
  });
  return next;
}

export interface SentenceEditorProps<S extends SentenceItem> {
  items: readonly S[];
  onItemsChange: (next: readonly S[]) => void;
  keyOf: (item: S, index: number) => string;
  /** One line above (bilingual) or a column beside (compact) the input. Must be stable. */
  renderHeader: (item: S, index: number) => ReactNode;
  /** Read-only source text shown with the input (bilingual layout). Must be stable. */
  renderSource?: (item: S, index: number) => ReactNode;
  /** Accessible name of a sentence's input. Must be stable. */
  textLabel: (item: S, index: number) => string;
  layout: "compact" | "bilingual";
  /** Offers the filler cleanup (Chinese drafts). */
  fillers: boolean;
  /** Sentences made only of fillers may be deleted whole (a transcript; a translation must keep every sentence). */
  deleteWholeSentences: boolean;
  /** A sentence that cannot be committed as it is; outlined in red. Must be stable. */
  isInvalid?: (item: S) => boolean;
  sync: DraftSyncSnapshot;
  onRetry: () => void;
  onLoadLatest: () => void;
  onKeepMine: () => void;
  onDiscard: () => void;
  onExit: () => void;
  onCommit: () => void;
  busy: boolean;
  commitDisabled?: boolean;
  /** Shown beside 「完成」, e.g. why it is disabled. */
  commitNote?: ReactNode;
  /** Notices under the toolbar. */
  notices?: ReactNode;
  testId?: string;
  /**
   * A column before each sentence's input (the transcript editor's speaker column); absent =
   * none, the layout as before. Must be stable.
   */
  renderLead?: (item: S, index: number) => ReactNode;
  /**
   * Indices into `items` of the sentences to show, a filter; absent = all. Hiding is display
   * only: editing, find, selection, undo and commit keep acting on the full `items` by their
   * original indices, so a filtered draft never loses a sentence.
   */
  visible?: ReadonlySet<number>;
  /** More toolbar controls, right after the find control. */
  toolbarExtra?: ReactNode;
  /**
   * Actions shown under the active sentence (the one last focused), for example "split here".
   * Must be stable.
   */
  rowActions?: (item: S, index: number) => ReactNode;
  /** Receives the editor's handle once mounted. */
  handleRef?: Ref<SentenceEditorHandle<S>>;
  /**
   * Where the list opens: the sentence at this original index, `offset` px below the list's top,
   * optionally with the cursor in it. Taken from the first render that has it and acted on once
   * per mount; later values are ignored. A sentence a filter hides is left alone.
   */
  initialScroll?: InitialScroll | undefined;
  /**
   * Told once per mount how the opening went: the outcome of the opening scroll when it ends for
   * good, or `"none"` right away when the first render had no `initialScroll` or its row is not
   * rendered (out of range, filtered away).
   */
  onInitialScrollDone?: (outcome: InitialScrollOutcome | "none") => void;
  /**
   * Per original index, whether the sentence opens a paragraph: such a row gets more space above
   * it and says so to assistive technology. Absent = no paragraph structure shown (a translation).
   */
  paragraphStarts?: readonly boolean[];
}

/** What a caller may do to the editor from outside: undoable batch changes and scrolling. */
export interface SentenceEditorHandle<S extends SentenceItem> {
  /**
   * Replaces the full items as one undoable batch: the current items join the undo stack
   * (bounded like every batch) and `label` is what the undo control then says it undoes.
   * Does nothing while the editor is busy, as the toolbar's own batch actions do.
   */
  applyBatch(next: readonly S[], label: string): void;
  /**
   * Scrolls the sentence at this original index into view and focuses its input. Does nothing
   * for a sentence a filter hides.
   */
  focusSentence(index: number): void;
  /** Whether any undo step would put back items that satisfy `test`. */
  hasUndo(test: (items: readonly S[]) => boolean): boolean;
  /**
   * Forgets the newest undo step whose items satisfy `test` and every step older than it, so
   * nothing can bring those items back (a speaker deleted meanwhile, for example).
   */
  dropUndo(test: (items: readonly S[]) => boolean): void;
}

/**
 * The editing surface shared by the transcript and translation drafts: a toolbar with the
 * save state, find, discard, exit and commit; a find panel docked under it (plain-text find
 * and replace, and the filler cleanup of Chinese drafts); one input per sentence. Batch edits
 * can be undone; typing in a sentence uses the input's own undo. Rows are memoized and
 * skipped by layout while off screen, so typing in one of thousands stays cheap.
 */
export function SentenceEditor<S extends SentenceItem>(props: SentenceEditorProps<S>) {
  const { t } = useTranslation();
  const { items } = props;
  const container = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const rowList = useRef<HTMLOListElement>(null);
  const [panel, setPanel] = useState<{ open: boolean; mode: "find" | "filler"; replace: boolean }>({ open: false, mode: "find", replace: false });
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [current, setCurrent] = useState(0);
  const [active, setActive] = useState<number | undefined>(undefined);
  const [undo, setUndoState] = useState<ReadonlyArray<UndoEntry<S>>>([]);
  // The stack as last set, for the handle's synchronous questions between a change and its render.
  const undoNow = useRef<ReadonlyArray<UndoEntry<S>>>(undo);
  const setUndo = useCallback((next: (stack: ReadonlyArray<UndoEntry<S>>) => ReadonlyArray<UndoEntry<S>>): void => {
    undoNow.current = next(undoNow.current);
    setUndoState(undoNow.current);
  }, []);
  const [confirmExit, setConfirmExit] = useState(false);

  // Stable callbacks for the memoized rows read the latest props through refs.
  const busyNow = useRef(false);
  const latest = useRef({ items, onItemsChange: props.onItemsChange, visible: props.visible });
  latest.current = { items, onItemsChange: props.onItemsChange, visible: props.visible };

  const texts = useMemo(() => items.map((item) => item.text), [items]);
  const { visible } = props;
  // What find, replace and the filler cleanup look at: hidden sentences read as empty, which
  // nothing matches, while indices stay those of the full items.
  const scopeTexts = useMemo(() => (visible === undefined ? texts : texts.map((text, index) => (visible.has(index) ? text : ""))), [texts, visible]);
  const matches = useMemo(() => (panel.open && panel.mode === "find" ? findMatches(scopeTexts, query, caseSensitive) : []), [panel.open, panel.mode, scopeTexts, query, caseSensitive]);
  const currentMatch = matches.length === 0 ? undefined : matches[Math.min(current, matches.length - 1)];

  const filler = useFillerState(scopeTexts, panel.open && panel.mode === "filler" && props.fillers, props.deleteWholeSentences);

  const hitRows = useMemo(() => {
    if (panel.mode === "filler") return new Set(filler.visibleHits.map((hit) => hit.index));
    return new Set(matches.map((match) => match.index));
  }, [panel.mode, matches, filler.visibleHits]);

  const onText = useCallback((index: number, text: string) => {
    const { items: now, onItemsChange } = latest.current;
    const next = [...now];
    const item = now[index];
    if (item === undefined) return;
    next[index] = { ...item, text };
    onItemsChange(next);
  }, []);

  const rowInput = (index: number): HTMLTextAreaElement | null =>
    container.current?.querySelector<HTMLTextAreaElement>(`[data-sentence-index="${index}"] textarea`) ?? null;

  /** Brings a sentence into view without taking focus from the find box. */
  const reveal = (index: number): void => {
    container.current?.querySelector(`[data-sentence-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" });
  };

  /** Moves focus, and the hit as the selection, into the sentence's input. */
  const enterSentence = useCallback((index: number, range?: { start: number; end: number }) => {
    const input = rowInput(index);
    if (input === null) return;
    input.focus();
    if (range !== undefined) input.setSelectionRange(range.start, range.end);
  }, []);

  const onPickRow = useCallback(
    (index: number) => {
      // A drag selecting the read-only source is not a request to edit.
      if (window.getSelection()?.isCollapsed === false) return;
      enterSentence(index);
    },
    [enterSentence],
  );

  useEffect(() => {
    if (currentMatch !== undefined) reveal(currentMatch.index);
  }, [currentMatch]);

  const batch = (next: readonly S[], label?: string): void => {
    const before = latest.current.items;
    setUndo((stack) => [...stack, { items: before, label }].slice(-DRAFT_BATCH_UNDO_DEPTH));
    latest.current.onItemsChange(next);
  };
  const undoLast = (): void => {
    const previous = undoNow.current.at(-1);
    if (previous === undefined) return;
    setUndo((stack) => stack.slice(0, -1));
    // A snapshot is put back as it was: nothing about it is worked out again.
    props.onItemsChange(previous.items);
  };
  const undoLabel = undo.at(-1)?.label;

  useImperativeHandle(
    props.handleRef,
    () => ({
      applyBatch: (next, label) => {
        // The same moments the toolbar's own batch actions are off: saving a commit, a conflict.
        if (!busyNow.current) batch(next, label);
      },
      focusSentence: (index) => {
        if (latest.current.visible?.has(index) === false) return;
        reveal(index);
        enterSentence(index);
      },
      hasUndo: (test) => undoNow.current.some((entry) => test(entry.items)),
      dropUndo: (test) => {
        setUndo((stack) => {
          const newest = stack.findLastIndex((entry) => test(entry.items));
          return newest < 0 ? stack : stack.slice(newest + 1);
        });
      },
    }),
    // The functions read everything through refs, state setters and stable callbacks.
    [],
  );

  const openPanel = (mode: "find" | "filler", replace: boolean): void => {
    setPanel((state) => ({ open: true, mode, replace: replace || (state.open && state.replace) }));
    if (mode === "find") {
      // The selection, when it is a single line, seeds the query.
      const selected = window.getSelection()?.toString() ?? "";
      if (selected !== "" && !selected.includes("\n")) setQuery(selected);
      requestAnimationFrame(() => {
        findInput.current?.focus();
        findInput.current?.select();
      });
    }
  };
  const closePanel = (): void => setPanel((state) => ({ ...state, open: false }));

  const onEditorKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const combo = blockedComboOf(event.nativeEvent);
    if (FIND_COMBOS.has(combo)) {
      event.preventDefault();
      openPanel("find", false);
    } else if (REPLACE_COMBOS.has(combo)) {
      event.preventDefault();
      openPanel("find", true);
    }
  };

  const step = (delta: number): void => {
    if (matches.length === 0) return;
    setCurrent((at) => (Math.min(at, matches.length - 1) + delta + matches.length) % matches.length);
  };

  const onFindKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    } else if (event.key === "Tab" && !event.shiftKey && currentMatch !== undefined) {
      event.preventDefault();
      enterSentence(currentMatch.index, currentMatch);
    }
  };

  const replaceCurrent = (): void => {
    if (currentMatch === undefined) return;
    batch(withTexts(items, applyReplace(texts, [currentMatch], replacement)));
  };
  const replaceMatches = (chosen: readonly TextMatch[]): void => {
    if (chosen.length === 0) return;
    batch(withTexts(items, applyReplace(texts, chosen, replacement)));
  };
  const deleteMatches = (chosen: readonly TextMatch[]): void => {
    if (chosen.length === 0) return;
    batch(withTexts(items, applyDelete(texts, chosen)));
  };
  const applyFillers = (): void => {
    const remove = new Set(filler.deleteWhole ? filler.whole : []);
    const cuts = filler.checkedHits.filter((hit) => !remove.has(hit.index));
    const cut = withTexts(items, applyDelete(texts, cuts));
    // A deleted sentence that opened a paragraph hands that on to the next one kept, so the rest
    // of its paragraph does not run into the one before.
    batch(remove.size === 0 ? cut : removeSentencesWithParagraphs(cut, remove));
    filler.reset();
  };

  // The opening position is the one this editor was opened with: a value arriving later, or
  // changing, must not pull the list away from where the user has since scrolled. The effect
  // depends only on whether there is one, which flips at most once, so it starts once per mount
  // (StrictMode's simulated remount disposes the first run and starts a fresh one).
  const opening = useRef<InitialScroll | undefined>(undefined);
  opening.current ??= props.initialScroll;
  const hasOpening = opening.current !== undefined;
  // The opening is reported once per mount, also across StrictMode's simulated remount, whose
  // first run is disposed without reporting anything.
  const reportedOpening = useRef(false);
  const onOpeningDone = useRef(props.onInitialScrollDone);
  onOpeningDone.current = props.onInitialScrollDone;
  useLayoutEffect(() => {
    const report = (outcome: InitialScrollOutcome | "none"): void => {
      if (reportedOpening.current) return;
      reportedOpening.current = true;
      onOpeningDone.current?.(outcome);
    };
    const target = opening.current;
    if (target === undefined || container.current === null || rowList.current === null) {
      report("none");
      return;
    }
    // A layout effect: the rows are in the DOM and the first correction lands before the first paint.
    const run = startInitialScroll(container.current, rowList.current, target, report);
    if (run === undefined) report("none");
    return () => run?.dispose();
  }, [hasOpening]);

  const busy = props.busy || props.sync.phase !== "editing" && props.sync.phase !== "saving";
  busyNow.current = busy;
  const { paragraphStarts } = props;
  // Which shown rows get the space of a new paragraph above them: one that opens a paragraph, or
  // one after hidden rows of which one did (a filter must not make two paragraphs look like
  // one). The first row shown needs no space above it, whatever opens there.
  const spacedRows = useMemo(() => {
    if (paragraphStarts === undefined) return undefined;
    const spaced = new Array<boolean>(items.length).fill(false);
    let opened = false;
    let seen = false;
    for (let index = 0; index < items.length; index += 1) {
      opened ||= paragraphStarts[index] === true;
      if (visible !== undefined && !visible.has(index)) continue;
      spaced[index] = seen && opened;
      opened = false;
      seen = true;
    }
    return spaced;
  }, [paragraphStarts, visible, items.length]);

  return (
    <div ref={container} className="flex h-full min-h-0 flex-col" onKeyDown={onEditorKey} data-testid={props.testId ?? "sentence-editor"}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2" role="toolbar" aria-label={t("editor.find.panel")}>
        <SaveStatus sync={props.sync} onRetry={props.onRetry} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={panel.open}
            onClick={() => (panel.open ? closePanel() : openPanel(panel.mode, false))}
            data-testid="editor-find-toggle"
          >
            <Search size={14} />
            {t("editor.toolbar.find")}
          </Button>
          {props.toolbarExtra}
          <Button
            size="sm"
            variant="ghost"
            disabled={undo.length === 0 || busy}
            title={undoLabel === undefined ? t("editor.toolbar.undoHint") : t("editor.toolbar.undoLabeled", { label: undoLabel })}
            {...(undoLabel === undefined ? {} : { "aria-label": t("editor.toolbar.undoLabeled", { label: undoLabel }) })}
            onClick={undoLast}
            data-testid="editor-undo"
          >
            <Undo2 size={14} />
            {t("editor.toolbar.undo")}
          </Button>
          <TwoStepButton
            size="sm"
            label={t("editor.toolbar.discard")}
            confirmLabel={t("editor.toolbar.discardConfirm")}
            onConfirm={props.onDiscard}
            disabled={busy}
            loading={props.sync.phase === "discarding"}
            title={t("editor.toolbar.discardHint")}
            data-testid="draft-discard"
          />
          <Button size="sm" disabled={props.sync.phase === "committing" || props.sync.phase === "discarding"} onClick={() => (props.sync.unsaved ? setConfirmExit(true) : props.onExit())} data-testid="draft-exit">
            {t("editor.toolbar.exit")}
          </Button>
          {props.commitNote}
          <Button size="sm" variant="primary" disabled={busy || props.commitDisabled === true || props.sync.conflict !== undefined} onClick={props.onCommit} data-testid="draft-commit">
            {t("editor.toolbar.done")}
          </Button>
        </div>
      </div>
      {props.sync.conflict === undefined ? null : (
        // Appears when a save finds the draft changed elsewhere, and must be resolved before going on.
        <Banner
          tone="warn"
          announce="alert"
          title={t("editor.conflict.message")}
          testId="draft-changed"
          actions={
            <>
              <Button size="sm" onClick={props.onLoadLatest} data-testid="draft-load-latest">
                {t("editor.conflict.loadLatest")}
              </Button>
              <Button size="sm" onClick={props.onKeepMine} data-testid="draft-keep-mine">
                {t("editor.conflict.keepMine")}
              </Button>
            </>
          }
        />
      )}
      {panel.open ? (
        <section className="flex flex-col gap-2 border-b border-line bg-sunken/40 px-4 py-2 text-xs" aria-label={t("editor.find.panel")} data-testid="find-panel">
          {visible === undefined ? null : (
            <p className="text-note text-muted" role="status" data-testid="find-scope-note">
              {t("editor.find.filteredScope", { count: visible.size })}
            </p>
          )}
          {props.fillers ? (
            <div className="flex gap-1" role="tablist">
              {(["find", "filler"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={panel.mode === mode}
                  className={`rounded px-2 py-0.5 ${panel.mode === mode ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-ink"}`}
                  onClick={() => openPanel(mode, false)}
                  data-testid={`find-mode-${mode}`}
                >
                  {mode === "find" ? t("editor.find.modeFind") : t("editor.find.modeFiller")}
                </button>
              ))}
              <IconButton label={t("editor.find.close")} onClick={closePanel} className="ml-auto" testId="find-close">
                <X size={14} />
              </IconButton>
            </div>
          ) : null}
          {panel.mode === "find" || !props.fillers ? (
            <FindSection
              findInput={findInput}
              query={query}
              setQuery={(value) => {
                setQuery(value);
                setCurrent(0);
              }}
              caseSensitive={caseSensitive}
              setCaseSensitive={setCaseSensitive}
              replaceOpen={panel.replace}
              toggleReplace={() => setPanel((state) => ({ ...state, replace: !state.replace }))}
              replacement={replacement}
              setReplacement={setReplacement}
              matches={matches}
              current={currentMatch === undefined ? undefined : matches.indexOf(currentMatch)}
              texts={texts}
              closable={!props.fillers}
              onClose={closePanel}
              onKey={onFindKey}
              onStep={step}
              onGo={(at) => {
                setCurrent(at);
                const match = matches[at];
                if (match !== undefined) enterSentence(match.index, match);
              }}
              disabled={busy}
              onReplace={replaceCurrent}
              onReplaceMatches={replaceMatches}
              onDeleteMatches={deleteMatches}
            />
          ) : (
            <FillerSection
              state={filler}
              texts={texts}
              deleteWholeSentences={props.deleteWholeSentences}
              disabled={busy}
              onApply={applyFillers}
              onGo={(hit) => enterSentence(hit.index, hit)}
            />
          )}
        </section>
      ) : null}
      {props.notices}
      <ol ref={rowList} className="@container min-h-0 flex-1 overflow-auto px-3 py-2" data-testid="sentence-rows">
        {items.map((item, index) =>
          visible !== undefined && !visible.has(index) ? null : (
          <SentenceRow
            key={props.keyOf(item, index)}
            item={item}
            index={index}
            hasHit={hitRows.has(index)}
            isCurrentHit={currentMatch?.index === index && panel.mode === "find"}
            isActive={active === index}
            paragraphStart={paragraphStarts?.[index] === true}
            spaced={spacedRows?.[index] === true}
            paragraphLabel={t("paragraphEditor.startLabel")}
            invalid={props.isInvalid?.(item) ?? false}
            layout={props.layout}
            renderHeader={props.renderHeader}
            renderSource={props.renderSource}
            renderLead={props.renderLead}
            rowActions={props.rowActions}
            textLabel={props.textLabel}
            onText={onText}
            onActive={setActive}
            onPick={onPickRow}
          />
          ),
        )}
      </ol>
      <ConfirmDialog
        open={confirmExit}
        title={t("editor.exitConfirm.title")}
        message={t("editor.exitConfirm.message")}
        confirmLabel={t("editor.exitConfirm.confirm")}
        danger
        onCancel={() => setConfirmExit(false)}
        onConfirm={() => {
          setConfirmExit(false);
          props.onExit();
        }}
      />
    </div>
  );
}

function SaveStatus(props: { sync: DraftSyncSnapshot; onRetry: () => void }) {
  const { t } = useTranslation();
  const { save } = props.sync;
  if (save === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-danger" role="status" data-testid="draft-save-status">
        {t("editor.status.failed")}
        {" · "}
        <button type="button" className={`rounded-sm font-medium underline-offset-2 hover:underline ${FOCUS_RING}`} onClick={props.onRetry} data-testid="draft-retry">
          {t("editor.status.retry")}
        </button>
      </span>
    );
  }
  // A conflict is named by its banner; the status only says the edits are not on the server.
  const label =
    save === "saving" ? t("editor.status.saving") : save === "pending" ? t("editor.status.pending") : save === "conflict" ? t("editor.status.unsaved") : t("editor.status.saved");
  return (
    <span className="text-xs text-muted" role="status" data-testid="draft-save-status">
      {label}
    </span>
  );
}

function IconButton(props: { label: string; onClick: () => void; children: ReactNode; className?: string; disabled?: boolean; pressed?: boolean; testId?: string }) {
  return (
    <Tooltip content={props.label}>
      <button
        type="button"
        aria-label={props.label}
        disabled={props.disabled}
        {...(props.pressed === undefined ? {} : { "aria-pressed": props.pressed })}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition duration-150 motion-reduce:transition-none hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING} ${props.pressed === true ? "bg-accent-soft text-accent" : "text-muted"} ${props.className ?? ""}`}
        onClick={props.onClick}
        data-testid={props.testId}
      >
        {props.children}
      </button>
    </Tooltip>
  );
}

/** A hit in its surrounding text, the hit in bold. */
function HitContext(props: { text: string; match: Pick<TextMatch, "start" | "end"> }) {
  const context = hitContext(props.text, props.match);
  return (
    <span className="min-w-0 truncate">
      {context.clippedStart ? "…" : ""}
      {context.before}
      <strong className="font-semibold text-ink">{context.hit}</strong>
      {context.after}
      {context.clippedEnd ? "…" : ""}
    </span>
  );
}

function FindSection(props: {
  findInput: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (value: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (value: boolean) => void;
  replaceOpen: boolean;
  toggleReplace: () => void;
  replacement: string;
  setReplacement: (value: string) => void;
  matches: readonly TextMatch[];
  current: number | undefined;
  texts: readonly string[];
  closable: boolean;
  onClose: () => void;
  onKey: (event: KeyboardEvent<HTMLInputElement>) => void;
  onStep: (delta: number) => void;
  onGo: (at: number) => void;
  disabled: boolean;
  onReplace: () => void;
  onReplaceMatches: (chosen: readonly TextMatch[]) => void;
  onDeleteMatches: (chosen: readonly TextMatch[]) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // Every result starts checked; the user unchecks the ones to keep.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const { matches } = props;
  useEffect(() => setUnchecked(new Set()), [matches]);
  const chosen = matches.filter((match) => !unchecked.has(matchKey(match)));
  const currentMatch = props.current === undefined ? undefined : matches[props.current];
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <TextInput
          ref={props.findInput}
          type="search"
          size="sm"
          className="max-w-72 flex-1"
          placeholder={t("editor.find.query")}
          aria-label={t("editor.find.query")}
          value={props.query}
          onChange={(event) => props.setQuery(event.target.value)}
          onKeyDown={props.onKey}
          data-testid="find-query"
        />
        <IconButton label={t("editor.find.caseSensitive")} pressed={props.caseSensitive} onClick={() => props.setCaseSensitive(!props.caseSensitive)} testId="find-case">
          <CaseSensitive size={16} />
        </IconButton>
        <span className="min-w-12 text-center font-mono text-muted tabular-nums" aria-live="polite" data-testid="find-counter">
          {props.query === "" ? "" : matches.length === 0 ? t("editor.find.none") : t("editor.find.counter", { current: (props.current ?? 0) + 1, total: matches.length })}
        </span>
        <IconButton label={t("editor.find.previous")} disabled={matches.length === 0} onClick={() => props.onStep(-1)} testId="find-previous">
          <ChevronUp size={16} />
        </IconButton>
        <IconButton label={t("editor.find.next")} disabled={matches.length === 0} onClick={() => props.onStep(1)} testId="find-next">
          <ChevronDown size={16} />
        </IconButton>
        <IconButton label={t("editor.find.toggleReplace")} pressed={props.replaceOpen} onClick={props.toggleReplace} testId="find-replace-toggle">
          <Replace size={14} />
        </IconButton>
        {props.closable ? (
          <IconButton label={t("editor.find.close")} onClick={props.onClose} testId="find-close">
            <X size={14} />
          </IconButton>
        ) : null}
      </div>
      {props.replaceOpen ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <TextInput
            size="sm"
            className="max-w-72 flex-1"
            placeholder={t("editor.find.replacement")}
            aria-label={t("editor.find.replacement")}
            value={props.replacement}
            onChange={(event) => props.setReplacement(event.target.value)}
            data-testid="find-replacement"
          />
          <Button size="sm" disabled={props.disabled || currentMatch === undefined} onClick={props.onReplace} data-testid="find-replace-one">
            {t("editor.find.replace")}
          </Button>
          <Button size="sm" disabled={props.disabled || matches.length === 0} onClick={() => props.onReplaceMatches(matches)} data-testid="find-replace-all">
            {t("editor.find.replaceAll")}
          </Button>
        </div>
      ) : null}
      {props.query === "" || matches.length === 0 ? null : (
        <div className="flex flex-col gap-1" data-testid="find-results">
          <div className="flex flex-wrap items-center gap-2 text-muted">
            <span>{t("editor.find.total", { count: matches.length })}</span>
            {currentMatch === undefined || expanded ? null : (
              <button type="button" className="flex min-w-0 max-w-full gap-1 text-left hover:text-ink" onClick={() => props.onGo(props.current ?? 0)} data-testid="find-current-context">
                <span className="shrink-0">{t("editor.find.sentence", { ordinal: currentMatch.index + 1 })}</span>
                <HitContext text={props.texts[currentMatch.index] ?? ""} match={currentMatch} />
              </button>
            )}
            <TextAction className="ml-auto" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} data-testid="find-expand">
              {expanded ? t("editor.find.collapse") : t("editor.find.expand")}
            </TextAction>
          </div>
          {expanded ? (
            <>
              <ul className="flex max-h-56 flex-col overflow-auto rounded border border-line bg-surface" data-testid="find-result-list">
                {matches.map((match, at) => {
                  const key = matchKey(match);
                  return (
                    <li key={key} className={`flex items-center gap-2 px-2 py-1 ${at === props.current ? "bg-accent-soft" : ""}`}>
                      <Checkbox
                        aria-label={t("editor.find.sentence", { ordinal: match.index + 1 })}
                        checked={!unchecked.has(key)}
                        onChange={(event) => {
                          const next = new Set(unchecked);
                          if (event.target.checked) next.delete(key);
                          else next.add(key);
                          setUnchecked(next);
                        }}
                      />
                      <button type="button" className="flex min-w-0 flex-1 gap-2 text-left" onClick={() => props.onGo(at)}>
                        <span className="w-14 shrink-0 text-muted">{t("editor.find.sentence", { ordinal: match.index + 1 })}</span>
                        <HitContext text={props.texts[match.index] ?? ""} match={match} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-1.5">
                {props.replaceOpen ? (
                  <Button size="sm" disabled={props.disabled || chosen.length === 0} onClick={() => props.onReplaceMatches(chosen)} data-testid="find-replace-selected">
                    {t("editor.find.replaceSelected")}
                  </Button>
                ) : null}
                <Button size="sm" disabled={props.disabled || chosen.length === 0} onClick={() => props.onDeleteMatches(chosen)} data-testid="find-delete-selected">
                  {t("editor.find.deleteSelected")}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </>
  );
}

const hitKey = (hit: FillerHit): string => `${hit.index}:${hit.start}`;

interface FillerState {
  hits: FillerHit[];
  whole: number[];
  words: string[];
  toggleWord: (word: string) => void;
  checked: ReadonlySet<string>;
  toggleHit: (hit: FillerHit) => void;
  deleteWhole: boolean;
  setDeleteWhole: (value: boolean) => void;
  /** Hits of the picked words. */
  visibleHits: FillerHit[];
  /** Checked hits of the picked words: what 「应用」 deletes. */
  checkedHits: FillerHit[];
  reset: () => void;
}

/**
 * The filler cleanup's choices. No word is picked at first; picking one checks its
 * high-confidence hits and leaves the maybe-meaningful ones unchecked.
 */
function useFillerState(texts: readonly string[], enabled: boolean, deleteWholeSentences: boolean): FillerState {
  const hits = useMemo(() => (enabled ? fillerCandidates(texts) : []), [enabled, texts]);
  const whole = useMemo(() => (enabled ? wholeSentenceFillers(texts) : []), [enabled, texts]);
  const [words, setWords] = useState<string[]>([]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [deleteWhole, setDeleteWhole] = useState(false);
  const visibleHits = useMemo(() => hits.filter((hit) => words.includes(hit.word)), [hits, words]);
  const checkedHits = useMemo(() => visibleHits.filter((hit) => checked.has(hitKey(hit))), [visibleHits, checked]);
  return {
    hits,
    whole,
    words,
    toggleWord: (word) => {
      const picked = words.includes(word);
      setWords(picked ? words.filter((item) => item !== word) : [...words, word]);
      const next = new Set(checked);
      for (const hit of hits) {
        if (hit.word !== word) continue;
        if (picked) next.delete(hitKey(hit));
        else if (hit.confidence === "high") next.add(hitKey(hit));
      }
      setChecked(next);
    },
    checked,
    toggleHit: (hit) => {
      const next = new Set(checked);
      if (next.has(hitKey(hit))) next.delete(hitKey(hit));
      else next.add(hitKey(hit));
      setChecked(next);
    },
    deleteWhole: deleteWholeSentences && deleteWhole,
    setDeleteWhole,
    visibleHits,
    checkedHits,
    reset: () => {
      setWords([]);
      setChecked(new Set());
      setDeleteWhole(false);
    },
  };
}

function FillerSection(props: { state: FillerState; texts: readonly string[]; deleteWholeSentences: boolean; disabled: boolean; onApply: () => void; onGo: (hit: FillerHit) => void }) {
  const { t } = useTranslation();
  const { state } = props;
  const [reviewing, setReviewing] = useState(false);
  const counts = fillerCounts(state.hits);
  const sentences = state.deleteWhole ? state.whole.length : 0;
  const nothing = state.checkedHits.length === 0 && sentences === 0;
  return (
    <div className="flex flex-col gap-2" data-testid="filler-section">
      <p className="text-note text-muted">{t("editor.filler.hint")}</p>
      {counts.length === 0 && state.whole.length === 0 ? <p className="text-note text-muted">{t("editor.filler.none")}</p> : null}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("editor.filler.words")}>
        {counts.map((entry) => {
          const picked = state.words.includes(entry.word);
          return (
            <button
              key={entry.word}
              type="button"
              aria-pressed={picked}
              className={`rounded-full border px-2.5 py-0.5 ${picked ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface hover:bg-sunken"}`}
              onClick={() => {
                setReviewing(false);
                state.toggleWord(entry.word);
              }}
              data-testid={`filler-word-${entry.word}`}
            >
              {t("editor.filler.chip", { word: entry.word, count: entry.count })}
            </button>
          );
        })}
      </div>
      {state.visibleHits.length > 0 ? (
        <ul className="flex max-h-56 flex-col overflow-auto rounded border border-line bg-surface" data-testid="filler-hits">
          {state.visibleHits.map((hit) => (
            <li key={hitKey(hit)} className="flex items-center gap-2 px-2 py-1" data-confidence={hit.confidence}>
              <Checkbox
                aria-label={t("editor.find.sentence", { ordinal: hit.index + 1 })}
                checked={state.checked.has(hitKey(hit))}
                onChange={() => {
                  setReviewing(false);
                  state.toggleHit(hit);
                }}
              />
              <button type="button" className="flex min-w-0 flex-1 gap-2 text-left" onClick={() => props.onGo(hit)}>
                <span className="w-14 shrink-0 text-muted">{t("editor.find.sentence", { ordinal: hit.index + 1 })}</span>
                <HitContext text={props.texts[hit.index] ?? ""} match={hit} />
              </button>
              <span className={`shrink-0 rounded px-1.5 text-xs ${hit.confidence === "high" ? "text-muted" : "bg-sunken text-ink"}`}>
                {hit.confidence === "high" ? t("editor.filler.high") : t("editor.filler.maybe")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {state.whole.length === 0 ? null : props.deleteWholeSentences ? (
        <label className="flex items-center gap-2">
          <Checkbox
            checked={state.deleteWhole}
            onChange={(event) => {
              setReviewing(false);
              state.setDeleteWhole(event.target.checked);
            }}
            data-testid="filler-whole"
          />
          {t("editor.filler.whole", { count: state.whole.length })}
        </label>
      ) : (
        <p className="text-note text-muted" data-testid="filler-whole-skipped">
          {t("editor.filler.wholeSkipped", { count: state.whole.length })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {reviewing ? (
          <>
            <span className="font-medium" role="status" data-testid="filler-preview">
              {t("editor.filler.preview", { count: state.checkedHits.length, sentences })}
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={props.disabled || nothing}
              onClick={() => {
                setReviewing(false);
                props.onApply();
              }}
              data-testid="filler-apply"
            >
              {t("editor.filler.apply")}
            </Button>
            <Button size="sm" onClick={() => setReviewing(false)}>
              {t("editor.filler.cancel")}
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={props.disabled || nothing} onClick={() => setReviewing(true)} data-testid="filler-review">
            {t("editor.filler.review")}
          </Button>
        )}
      </div>
    </div>
  );
}

interface RowProps<S extends SentenceItem> {
  item: S;
  index: number;
  hasHit: boolean;
  isCurrentHit: boolean;
  isActive: boolean;
  /** Opens a paragraph: said to assistive technology. */
  paragraphStart: boolean;
  /** Opens a paragraph below another row: more space above it. */
  spaced: boolean;
  paragraphLabel: string;
  invalid: boolean;
  layout: "compact" | "bilingual";
  renderHeader: (item: S, index: number) => ReactNode;
  renderSource: ((item: S, index: number) => ReactNode) | undefined;
  renderLead: ((item: S, index: number) => ReactNode) | undefined;
  rowActions: ((item: S, index: number) => ReactNode) | undefined;
  textLabel: (item: S, index: number) => string;
  onText: (index: number, text: string) => void;
  onActive: (index: number) => void;
  onPick: (index: number) => void;
}

/**
 * One sentence. Memoized on its own item and flags, so an edit re-renders only its row; the
 * browser also skips laying out rows that are off screen.
 */
const SentenceRow = memo(function SentenceRow<S extends SentenceItem>(props: RowProps<S>) {
  const { item, index } = props;
  const ring = props.isCurrentHit ? "ring-2 ring-accent/70" : props.isActive ? "ring-1 ring-accent/35" : "";
  const input = (
    <textarea
      aria-label={props.textLabel(item, index)}
      aria-invalid={props.invalid}
      {...(props.paragraphStart ? { "aria-description": props.paragraphLabel } : {})}
      className={`min-h-8 w-full resize-none rounded border bg-surface px-2 py-1 leading-6 text-ink [field-sizing:content] focus-visible:outline-2 focus-visible:outline-accent ${props.layout === "bilingual" ? "text-[15px]" : "text-sm"} ${props.invalid ? "border-danger" : "border-line"}`}
      rows={1}
      value={item.text}
      onChange={(event) => props.onText(index, event.target.value)}
      onFocus={() => props.onActive(index)}
    />
  );
  const lead = props.renderLead === undefined ? null : <div className="shrink-0" data-row-control="">{props.renderLead(item, index)}</div>;
  const bilingualBody = (
    <>
      <div className="font-mono text-[11px] text-muted">{props.renderHeader(item, index)}</div>
      <div className="grid gap-1.5 @min-[960px]:grid-cols-2 @min-[960px]:gap-4">
        {props.renderSource === undefined ? null : <div className="text-sm leading-6 text-muted select-text">{props.renderSource(item, index)}</div>}
        {input}
      </div>
    </>
  );
  const bilingual =
    props.renderLead === undefined ? (
      <div className="flex flex-col gap-1">{bilingualBody}</div>
    ) : (
      <div className="flex items-start gap-2">
        {lead}
        <div className="flex min-w-0 flex-1 flex-col gap-1">{bilingualBody}</div>
      </div>
    );
  const actions =
    props.isActive && props.rowActions !== undefined ? (
      <div className="mt-1 flex flex-wrap items-center gap-1.5" data-row-control="" data-testid="row-actions">
        {props.rowActions(item, index)}
      </div>
    ) : null;
  return (
    <li
      className={`${props.spaced ? "mt-5 mb-0.5" : "my-0.5"} rounded-md border-l-2 px-2 py-1.5 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto] ${props.hasHit ? "border-l-accent" : "border-l-transparent"} ${ring}`}
      data-sentence-index={index}
      {...(props.paragraphStart ? { "data-paragraph-start": "true" } : {})}
      {...(props.isCurrentHit ? { "data-current-hit": "true" } : {})}
      {...(props.hasHit ? { "data-has-hit": "true" } : {})}
      onClick={(event) => {
        if (event.target instanceof HTMLTextAreaElement) return;
        // Controls of the lead column and the row actions, and portalled menus opened from them
        // (React bubbles their clicks here), act on their own and must keep the focus.
        if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target) || event.target.closest("[data-row-control]") !== null) return;
        props.onPick(index);
      }}
    >
      {props.layout === "compact" ? (
        <div className="flex items-start gap-2">
          <span className="w-14 shrink-0 pt-1.5 font-mono text-xs text-muted">{props.renderHeader(item, index)}</span>
          {lead}
          {input}
        </div>
      ) : (
        bilingual
      )}
      {actions}
    </li>
  );
}) as <S extends SentenceItem>(props: RowProps<S>) => ReactNode;
