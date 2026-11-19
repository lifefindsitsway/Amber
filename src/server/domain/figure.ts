import { FIGURE_DELETED_RETENTION_DAYS } from "../../shared/defaults.ts";
import type { FigureAnchorSide, FigureSource } from "../../shared/dto/figure.ts";

/**
 * A figure in a Content's reading view: a captured frame or an uploaded or pasted image,
 * shown between paragraphs with an optional caption. The image (always WebP, re-encoded by
 * Amber or checked structurally when a content pack carried it) never changes; caption, width
 * and place do, each change bumping `version`.
 */
export interface ContentFigure {
  id: string;
  contentId: string;
  userId: string;
  source: FigureSource;
  /** Only on a capture: the media time of the frame. */
  capturedAtMs?: number;
  /** Where the figure falls back to by time; a capture's own time unless it was moved. */
  displayMs: number;
  /**
   * The sentence the user last placed it next to. A soft reference without a foreign key: the
   * revision may be gone, and then the figure is placed by `displayMs`.
   */
  anchor?: { revisionId: string; segmentId: string; side: FigureAnchorSide };
  /** Orders figures that land in the same gap, smaller first. */
  sortKey: number;
  widthRatio: number;
  caption?: string;
  image: { width: number; height: number; bytes: number; sha256: string };
  version: number;
  deletedAt?: number;
  /**
   * The id this figure had on the device a content pack carried it from; absent for one made
   * here. Its transfer identity is `originId ?? id`. Written on insert only.
   */
  originId?: string;
  createdAt: number;
  updatedAt: number;
}

const MS_PER_DAY = 86_400_000;

/** How long a deleted figure stays restorable. */
export const FIGURE_DELETED_RETENTION_MS = FIGURE_DELETED_RETENTION_DAYS * MS_PER_DAY;
