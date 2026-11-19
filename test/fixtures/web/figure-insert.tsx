import type { ReactNode } from "react";
import { vi } from "vitest";
import { figureDtoSchema, type FigureDto, type FigurePlacement } from "../../../src/shared/dto/figure.ts";
import { ContentPageProvider } from "../../../src/web/pages/content/content-context.tsx";
import { ReaderFigureProvider, useRegisterReaderFigures, type FigureInsertTarget, type ReaderFigureApi } from "../../../src/web/pages/content/figure-context.ts";
import { contentDetail } from "./content-data.ts";

/** Inserting figures: a reading view's figure API the test steers, and figures as the server returns them. */

export const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

export function pngFile(name = "图.png"): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

/** The place after sentence `segmentId` of revision `r1`. */
export function targetAfter(segmentId: string, displayMs: number, sortKey = 0): FigureInsertTarget {
  const placement: FigurePlacement = { displayMs, anchor: { revisionId: "r1", segmentId, side: "after" }, sortKey };
  return { revisionId: "r1", segmentId, side: "after", placement };
}

let seq = 0;
export function figure(overrides: Partial<FigureDto> = {}): FigureDto {
  seq += 1;
  return figureDtoSchema.parse({
    id: `F${seq}`,
    contentId: "c1",
    source: "upload",
    placement: { displayMs: 0, anchor: null, sortKey: 0 },
    widthRatio: 0.7,
    image: { width: 4, height: 3, bytes: 10, sha256: String(seq).padStart(64, "0") },
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

/** A figure API whose places the test changes between calls, as playback and scrolling would. */
export function steeredApi(initial: FigureInsertTarget) {
  const state = { target: initial };
  const api = {
    contentId: "c1",
    revisionId: "r1",
    captureTarget: vi.fn((): FigureInsertTarget | undefined => state.target),
    targetForTime: vi.fn((atMs: number): FigureInsertTarget | undefined => targetAfter(`t${atMs}`, atMs)),
    revealFigure: vi.fn((_figureId: string) => undefined),
  } satisfies ReaderFigureApi;
  return { api, state };
}

function Register(props: { api: ReaderFigureApi | undefined }) {
  useRegisterReaderFigures(props.api);
  return null;
}

/** The content page around `children`, with `api` registered as the reading view's (none = no reading view). */
export function FigurePage(props: { api: ReaderFigureApi | undefined; children: ReactNode }) {
  const state = {
    content: contentDetail(),
    primaryRevisionId: "r1",
    selection: undefined,
    select: vi.fn(),
    openTab: vi.fn(),
    highlightThreshold: 80,
    setHighlightThreshold: vi.fn(),
    openSubtitleEditor: vi.fn(),
    navigation: 0,
    switchRevision: vi.fn(),
  };
  return (
    <ContentPageProvider value={state}>
      <ReaderFigureProvider>
        <Register api={props.api} />
        {props.children}
      </ReaderFigureProvider>
    </ContentPageProvider>
  );
}
