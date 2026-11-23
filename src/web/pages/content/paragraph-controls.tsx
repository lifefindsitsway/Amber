import { ArrowUpToLine, Pilcrow } from "lucide-react";
import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  chapterStartIndices,
  derivedParagraphStarts,
  hasExplicitParagraphs,
  materializeParagraphs,
  mergeParagraph,
  paragraphStartInfo,
  splitParagraph,
  type MergeBlock,
  type ParagraphStartInfo,
} from "../../../shared/paragraph-marks.ts";
import type { ReadingChapter, ReadingSentence } from "../../../shared/reading.ts";
import { blockedComboOf } from "../../shortcut-registry.tsx";
import { Button } from "../../ui/button.tsx";
import type { SentenceEditorHandle } from "./sentence-editor.tsx";
import type { DraftSegment } from "./speaker-draft.ts";

/** Why the paragraph action of a sentence is off: a start that always stays one, or the sentence before it out of sight. */
export type ParagraphBlock = MergeBlock | "hidden";

/** The one paragraph action a sentence offers: open a paragraph there, or join it to the one before. */
export interface ParagraphAction {
  kind: "split" | "merge";
  /** Present when the action cannot be taken, and why. */
  blocked?: ParagraphBlock;
}

/**
 * The paragraph action of the sentence at `index`; `undefined` past the end. A start the
 * first sentence, a chapter or a change of speaker makes cannot be merged; and while a filter
 * hides the sentence before, neither action is offered, since the user could not see what the
 * paragraph is joined to or split from.
 */
export function paragraphAction(infos: readonly ParagraphStartInfo[], visible: ReadonlySet<number> | undefined, index: number): ParagraphAction | undefined {
  const info = infos[index];
  if (info === undefined) return undefined;
  const kind = info.start ? "merge" : "split";
  if (info.mergeBlock !== undefined) return { kind, blocked: info.mergeBlock };
  if (visible !== undefined && index > 0 && !visible.has(index - 1)) return { kind, blocked: "hidden" };
  return { kind };
}

/** The paragraph shortcut's combinations: Ctrl+Enter, or ⌘+Enter, the main key or the keypad's. */
const PARAGRAPH_COMBOS = new Set(["Ctrl+Enter", "Meta+Enter", "Ctrl+NumpadEnter", "Meta+NumpadEnter"]);

/**
 * Whether a key is the paragraph shortcut. Never while an input method is composing, where
 * Enter belongs to the composition.
 */
export function isParagraphShortcut(event: Pick<globalThis.KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  return PARAGRAPH_COMBOS.has(blockedComboOf(event));
}

/** Apple keyboards name the shortcut with ⌘. */
const isApple = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent);

/** What the rows' paragraph and split controls read of the draft's paragraphs. */
export interface ParagraphEditing {
  infos: readonly ParagraphStartInfo[];
  visible: ReadonlySet<number> | undefined;
  /** Edits are not taken now (a commit or a conflict in progress). */
  locked: boolean;
  /** Takes the sentence's paragraph action as one undoable step; false when it is off. */
  toggle(index: number): boolean;
  /** The draft with explicit paragraphs frozen as the editor shows them now; unchanged when it already has them. */
  materialize(segments: readonly DraftSegment[]): DraftSegment[];
  /** Splitting offers each half a speaker: the draft has speakers, or the user started giving it some. */
  speakerPickers: boolean;
}

const ParagraphContext = createContext<ParagraphEditing | undefined>(undefined);

export function ParagraphEditingProvider(props: { value: ParagraphEditing; children: ReactNode }) {
  return <ParagraphContext.Provider value={props.value}>{props.children}</ParagraphContext.Provider>;
}

export function useParagraphEditingContext(): ParagraphEditing {
  const value = useContext(ParagraphContext);
  if (value === undefined) throw new Error("ParagraphEditingProvider missing");
  return value;
}

const NO_STARTS: readonly boolean[] = [];

/**
 * Paragraphs of the transcript draft as the editor shows and edits them. Starts are the
 * draft's explicit marks, or, while it has none, the paragraphs the reading view derives;
 * together with changes of speaker and chapter starts. The first paragraph action on a draft
 * without marks first freezes every start shown as explicit marks, in the same undoable step, so
 * nothing a reader sees moves except what the user changed.
 */
export function useParagraphEditing(args: {
  segments: readonly DraftSegment[];
  /** Who each sentence reads as (`null` = unassigned). */
  resolved: ReadonlyArray<string | null>;
  chapters: readonly ReadingChapter[];
  visible: ReadonlySet<number> | undefined;
  locked: boolean;
  speakerPickers: boolean;
  handleRef: RefObject<SentenceEditorHandle<DraftSegment> | null>;
}) {
  const { t } = useTranslation();
  const { segments, resolved, chapters, visible, locked, speakerPickers, handleRef } = args;
  const explicit = hasExplicitParagraphs(segments);
  const sentences = useMemo(
    () =>
      segments.map((segment, index): ReadingSentence => {
        const speakerId = resolved[index] ?? null;
        return { startMs: segment.startMs, endMs: segment.endMs, text: segment.text, ...(speakerId === null ? {} : { speakerId }) };
      }),
    [segments, resolved],
  );
  const chapterStarts = useMemo(() => chapterStartIndices(sentences, chapters), [sentences, chapters]);
  const derived = useMemo(() => (explicit ? NO_STARTS : derivedParagraphStarts(sentences, chapters)), [explicit, sentences, chapters]);
  const infos = useMemo(() => paragraphStartInfo(segments, resolved, chapterStarts, derived), [segments, resolved, chapterStarts, derived]);
  const starts = useMemo(() => infos.map((info) => info.start), [infos]);
  const [announcement, setAnnouncement] = useState<{ text: string; count: number }>({ text: "", count: 0 });
  const announce = useCallback((text: string) => setAnnouncement((now) => ({ text, count: now.count + 1 })), []);

  const latest = useRef({ segments, infos, starts, visible, locked });
  latest.current = { segments, infos, starts, visible, locked };

  // The caller passes the draft as it is on screen, whose shown starts these are; a draft that
  // already has marks keeps its own.
  const materialize = useCallback((from: readonly DraftSegment[]): DraftSegment[] => materializeParagraphs(from, latest.current.starts), []);

  const toggle = useCallback(
    (index: number): boolean => {
      const now = latest.current;
      const action = paragraphAction(now.infos, now.visible, index);
      if (action === undefined || now.locked) return false;
      if (action.blocked !== undefined) {
        announce(t(`paragraphEditor.blocked.${action.blocked}`));
        return false;
      }
      const from = materializeParagraphs(now.segments, now.starts);
      const next = action.kind === "split" ? splitParagraph(from, index) : mergeParagraph(from, index);
      handleRef.current?.applyBatch(next, t(`paragraphEditor.undo.${action.kind}`));
      announce(t(`paragraphEditor.done.${action.kind}`));
      return true;
    },
    [announce, handleRef, t],
  );

  /** Ctrl/⌘+Enter in a sentence's input takes that sentence's paragraph action; plain Enter stays the input's. */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!isParagraphShortcut(event.nativeEvent)) return;
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      const row = target.closest<HTMLElement>("[data-sentence-index]");
      const index = row === null ? Number.NaN : Number(row.dataset["sentenceIndex"]);
      if (!Number.isInteger(index)) return;
      event.preventDefault();
      toggle(index);
    },
    [toggle],
  );

  const contextValue = useMemo<ParagraphEditing>(() => ({ infos, visible, locked, toggle, materialize, speakerPickers }), [infos, visible, locked, toggle, materialize, speakerPickers]);

  // Repeating the same words is still news: the count alternates an invisible mark so the text changes.
  const status = announcement.text === "" ? "" : `${announcement.text}${announcement.count % 2 === 0 ? "" : "\u200b"}`;
  return { starts, contextValue, onKeyDown, status };
}

/**
 * The paragraph action under the active sentence: 「从这句另起一段」 where it does not open a
 * paragraph, 「并入上一段」 where it does. When it is off, why is said right next to it.
 */
export function ParagraphControl(props: { index: number }) {
  const { t } = useTranslation();
  const editing = useParagraphEditingContext();
  const reasonId = useId();
  const action = paragraphAction(editing.infos, editing.visible, props.index);
  if (action === undefined) return null;
  const apple = isApple();
  const Icon = action.kind === "split" ? Pilcrow : ArrowUpToLine;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="paragraph-control" data-action={action.kind}>
      <Button
        size="sm"
        variant="ghost"
        disabled={action.blocked !== undefined || editing.locked}
        onClick={() => editing.toggle(props.index)}
        aria-keyshortcuts={apple ? "Meta+Enter" : "Control+Enter"}
        {...(action.blocked === undefined ? {} : { "aria-describedby": reasonId })}
        data-testid="paragraph-action"
      >
        <Icon size={13} aria-hidden="true" />
        {t(`paragraphEditor.${action.kind}`)}
        <kbd className="rounded border border-line px-1 font-mono text-[11px] font-normal text-muted" aria-hidden="true">
          {apple ? t("paragraphEditor.shortcutMac") : t("paragraphEditor.shortcut")}
        </kbd>
      </Button>
      {action.blocked === undefined ? null : (
        <span id={reasonId} className="text-note text-muted" data-testid="paragraph-blocked" data-reason={action.blocked}>
          {t(`paragraphEditor.blocked.${action.blocked}`)}
        </span>
      )}
    </div>
  );
}
