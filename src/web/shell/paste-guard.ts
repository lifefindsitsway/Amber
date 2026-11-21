import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { linesOf, linkPaste, recognizeLink } from "../links.ts";

/** Location state the new page reads to prefill its link box. */
export interface NewPagePrefill {
  prefill: string;
  /** How many links were taken out of a share text, when other words were left out. */
  pasteNote?: number;
}

const EDITABLE_SELECTOR = ['[contenteditable=""]', '[contenteditable="true"]', '[role="textbox"]'].join(",");
const DIALOG_SELECTOR = ['[role="dialog"]', '[role="alertdialog"]'].join(",");
/** A dropdown trigger, or an open menu or list: a paste there is never a gesture of its own. */
const PICKER_SELECTOR = ['[role="combobox"]', '[role="menu"]', '[role="listbox"]'].join(",");

/** Whether focus on `element` means a paste belongs to it: a form field, or rich or plain editable text. */
export function isEditable(element: Element | null): boolean {
  if (element === null) {
    return false;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true;
  }
  return element.closest(EDITABLE_SELECTOR) !== null;
}

/** Whether the clipboard holds an image file. */
function hasImage(data: DataTransfer | null): boolean {
  return [...(data?.items ?? [])].some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

/** Whether focus is on a dropdown trigger or inside an open menu or list. */
export function inPicker(element: Element | null): boolean {
  return element !== null && element.closest(PICKER_SELECTOR) !== null;
}

/**
 * Decides whether a paste is an "open this link" gesture. All four guards
 * must hold, otherwise the paste stays an ordinary paste: focus is not in an editable
 * field, no dialog is open, the text holds a supported link, and the new page is not
 * already showing. Returns what to prefill: the same tidied links a paste on the new page
 * would leave, so an unsupported link comes along and is shown as not added there.
 */
export function pasteTarget(input: { text: string; activeElement: Element | null; dialogOpen: boolean; pathname: string }): NewPagePrefill | undefined {
  if (isEditable(input.activeElement) || input.dialogOpen || input.pathname === "/new") {
    return undefined;
  }
  const paste = linkPaste(input.text);
  if (paste === undefined) return undefined;
  return { prefill: paste.text, ...(paste.tidied ? { pasteNote: paste.count } : {}) };
}

/**
 * Takes a paste that is not a link gesture: the reading view registers one while it can
 * insert a figure. It returns true when it handled the paste (then the default is prevented);
 * it is given the same guards' facts and decides on images itself. One paste triggers at most
 * one action: a supported link always wins, as before.
 */
export type ImagePasteHandler = (event: ClipboardEvent, context: { activeElement: Element | null; dialogOpen: boolean }) => boolean;

let imagePasteHandler: ImagePasteHandler | undefined;

/** Registers the image paste handler; returns the function that removes it again. */
export function registerImagePasteHandler(handler: ImagePasteHandler): () => void {
  imagePasteHandler = handler;
  return () => {
    if (imagePasteHandler === handler) imagePasteHandler = undefined;
  };
}

/** Document-level URL paste that jumps to the new page when all four guards pass; otherwise an image paste may be handled. */
export function usePasteGuard(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    const listener = (event: ClipboardEvent): void => {
      const activeElement = document.activeElement;
      // A dropdown or menu has focus: neither a jump nor a figure, and the paste is not touched.
      if (inPicker(activeElement)) return;
      const dialogOpen = document.querySelector(DIALOG_SELECTOR) !== null;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      // Copied web content carries an image together with its text; a link merely mentioned in
      // that text must not take the image away. With an image, only a line that is wholly a
      // supported link still counts as pasting a link.
      const linkGesture = !hasImage(event.clipboardData) || linesOf(text).some((line) => recognizeLink(line) !== undefined);
      const state = linkGesture ? pasteTarget({ text, activeElement, dialogOpen, pathname }) : undefined;
      if (state === undefined) {
        if (imagePasteHandler?.(event, { activeElement, dialogOpen }) === true) event.preventDefault();
        return;
      }
      event.preventDefault();
      void navigate("/new", { state });
    };
    document.addEventListener("paste", listener);
    return () => document.removeEventListener("paste", listener);
  }, [navigate, pathname]);
}

type TextField = HTMLTextAreaElement | HTMLInputElement;

/**
 * Inserts `text` over the field's selection the way typing does, so the browser's undo and redo
 * cover it. False when the browser cannot; the caller then sets the value itself.
 */
function insertAsTyped(field: TextField, text: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  field.focus();
  try {
    return document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

/**
 * Link fields that tidy a pasted share text: when the paste holds a supported link among other
 * words, only its links go in, at the caret. In a multi-line field they go one per line, with a
 * line break added before or after where the neighbouring text would otherwise run on. A paste
 * without a supported link is left to the browser. `note` counts the links of the last tidied
 * paste and is cleared by the next edit; the clipboard text itself is not kept.
 */
export function useLinkPasteField<T extends TextField>(options: { value: string; onValue: (value: string) => void; multiline: boolean; initialNote?: number | undefined }) {
  const ref = useRef<T>(null);
  const [note, setNote] = useState<number | undefined>(options.initialNote);
  // Where the caret goes once a value set directly (without the browser's insert) is rendered.
  const caret = useRef<number | undefined>(undefined);
  const { value, onValue, multiline } = options;

  useLayoutEffect(() => {
    const field = ref.current;
    if (caret.current === undefined || field === null) return;
    field.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  }, [value]);

  const onChange = useCallback(
    (next: string): void => {
      setNote(undefined);
      onValue(next);
    },
    [onValue],
  );

  const onPaste = useCallback(
    (event: ReactClipboardEvent<T>): void => {
      const field = event.currentTarget;
      const pasted = linkPaste(event.clipboardData.getData("text/plain"), multiline ? "\n" : " ");
      // A plain list of links pastes as it is; a single-line field also takes several links on
      // separate lines this way, since it would drop the line breaks between them.
      if (pasted === undefined || !(pasted.tidied || (!multiline && pasted.count > 1))) return;
      event.preventDefault();
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      const before = field.value.slice(0, start);
      const after = field.value.slice(end);
      const gap = multiline ? "\n" : " ";
      const insert = `${before === "" || before.endsWith(gap) ? "" : gap}${pasted.text}${after === "" || after.startsWith(gap) ? "" : gap}`;
      if (!insertAsTyped(field, insert)) {
        caret.current = start + insert.length;
        onValue(before + insert + after);
      }
      // After the insert: its own change event clears the note, this sets the new one.
      setNote(pasted.tidied ? pasted.count : undefined);
    },
    [multiline, onValue],
  );

  return { ref, note, onChange, onPaste };
}
