import { useEffect, useRef } from "react";
import { isEditable, registerImagePasteHandler } from "../../shell/paste-guard.ts";
import { useContentPage } from "./content-context.tsx";
import { useReaderFigures, type ReaderFigureApi } from "./figure-context.ts";
import { figureInsertStatus, insertTarget, useFigureInserter, type FigureInserter } from "./figure-insert.ts";

/**
 * The image a paste carries, if any: the first file item whose type is an image. Copying an
 * image in most programs puts it there as a PNG; a pasted file of another type is still
 * returned, so the reading view can say why it cannot take it.
 */
export function pastedImage(data: Pick<DataTransfer, "items"> | null | undefined): File | undefined {
  const items = data?.items;
  if (items === undefined || items === null) return undefined;
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null) return file;
  }
  return undefined;
}

/**
 * Whether a paste that is not a link gesture becomes a figure, and where. Never while focus is
 * in an editable field or a dialog is open (an ordinary paste there), nor without a reading
 * view that can take figures or without an image. The place is fixed now, at the press.
 */
export function imagePasteDecision(input: {
  activeElement: Element | null;
  dialogOpen: boolean;
  api: Pick<ReaderFigureApi, "captureTarget" | "targetForTime"> | undefined;
  image: File | undefined;
}): { file: File; target: NonNullable<ReturnType<typeof insertTarget>> } | undefined {
  if (input.dialogOpen || isEditable(input.activeElement) || input.api === undefined || input.image === undefined) return undefined;
  const target = insertTarget(input.api);
  return target === undefined ? undefined : { file: input.image, target };
}

/**
 * Registers the image paste handler while the content page is open; leaving the Content
 * cancels its inserts under way. A supported link in the
 * clipboard is taken by the link paste first (it opens the new page); otherwise an image
 * pasted while the reading view can take figures is inserted after the current paragraph.
 */
export function useFigurePaste(): void {
  const { content } = useContentPage();
  const api = useReaderFigures();
  const inserter = useFigureInserter(content.id);
  const latest = useRef<{ api: ReaderFigureApi | undefined; inserter: FigureInserter }>({ api, inserter });
  latest.current = { api, inserter };
  const contentId = content.id;
  useEffect(() => {
    const unregister = registerImagePasteHandler((event, context) => {
      const decision = imagePasteDecision({ ...context, api: latest.current.api, image: pastedImage(event.clipboardData) });
      if (decision === undefined) return false;
      void latest.current.inserter.upload({ file: decision.file, target: decision.target, origin: "reader", kind: "paste" });
      return true;
    });
    return () => {
      unregister();
      // Leaving the Content (another one, or another page) cancels the uploads still under way
      // and forgets what was said: an answer arriving later says nothing.
      figureInsertStatus.clear();
    };
  }, [contentId]);
}
