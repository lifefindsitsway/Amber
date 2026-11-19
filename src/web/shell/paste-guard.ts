import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { recognizeLinks } from "../links.ts";

/** Location state the new page reads to prefill its link box. */
export interface NewPagePrefill {
  prefill: string;
}

const EDITABLE_SELECTOR = ['[contenteditable=""]', '[contenteditable="true"]', '[role="textbox"]'].join(",");
const DIALOG_SELECTOR = ['[role="dialog"]', '[role="alertdialog"]'].join(",");

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

/**
 * Decides whether a paste is an "open this link" gesture. All four guards
 * must hold, otherwise the paste stays an ordinary paste: focus is not in an editable
 * field, no dialog is open, the text holds a supported link, and the new page is not
 * already showing. Returns the links to prefill.
 */
export function pasteTarget(input: { text: string; activeElement: Element | null; dialogOpen: boolean; pathname: string }): string | undefined {
  if (isEditable(input.activeElement) || input.dialogOpen || input.pathname === "/new") {
    return undefined;
  }
  const links = recognizeLinks(input.text);
  return links.length === 0 ? undefined : links.map((link) => link.url).join("\n");
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
      const dialogOpen = document.querySelector(DIALOG_SELECTOR) !== null;
      const prefill = pasteTarget({ text: event.clipboardData?.getData("text/plain") ?? "", activeElement, dialogOpen, pathname });
      if (prefill === undefined) {
        if (imagePasteHandler?.(event, { activeElement, dialogOpen }) === true) event.preventDefault();
        return;
      }
      event.preventDefault();
      const state: NewPagePrefill = { prefill };
      void navigate("/new", { state });
    };
    document.addEventListener("paste", listener);
    return () => document.removeEventListener("paste", listener);
  }, [navigate, pathname]);
}
