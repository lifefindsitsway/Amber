import { createContext, useContext, type ReactNode } from "react";
import type { ContentDetailDto } from "../../../shared/dto/content.ts";

/** A sentence picked anywhere on the page (citation, chapter, transcript, subtitles). */
export interface SegmentSelection {
  revisionId: string;
  segmentId: string;
}

export interface ContentPageState {
  content: ContentDetailDto;
  primaryRevisionId: string | undefined;
  selection: SegmentSelection | undefined;
  /** Selects a sentence; with `startMs` the player seeks there too. Counts as a navigation. */
  select(selection: SegmentSelection, startMs?: number): void;
  /**
   * How many times `select` has been called on this page. A view restoring a position the user
   * had before (coming back from the editor) gives up once this moves: the user went somewhere.
   */
  navigation: number;
  /**
   * Moves the page to another revision in one step: the `revision` address parameter (`null`
   * removes it, showing the current text), the `segment` parameter and the selection are all
   * written together, so nothing renders the new revision with the old selection. Neither seeks
   * nor counts as a navigation; used when a commit replaces the text being read.
   */
  switchRevision(next: { revision: string | null; selection: SegmentSelection | undefined }): void;
  openTab(tab: ContentTab): void;
  /** Minimum score of the AI highlights shown, shared by the tab and the player timeline; not persisted. */
  highlightThreshold: number;
  setHighlightThreshold(value: number): void;
  /** Turns the local player's subtitles on if needed and opens its style and position editor. */
  openSubtitleEditor(): void;
  /** The video cache the local player is showing, if any; the subtitled video export starts from it. */
  playingAssetId?: string | undefined;
}

export const CONTENT_TABS = ["summary", "transcript", "subtitles", "translation", "ai-highlights"] as const;
export type ContentTab = (typeof CONTENT_TABS)[number];

export function parseTab(value: string | null): ContentTab {
  return CONTENT_TABS.find((tab) => tab === value) ?? "summary";
}

const Context = createContext<ContentPageState | undefined>(undefined);

export function ContentPageProvider(props: { value: ContentPageState; children: ReactNode }) {
  return <Context.Provider value={props.value}>{props.children}</Context.Provider>;
}

export function useContentPage(): ContentPageState {
  const value = useContext(Context);
  if (value === undefined) {
    throw new Error("ContentPageProvider missing");
  }
  return value;
}
