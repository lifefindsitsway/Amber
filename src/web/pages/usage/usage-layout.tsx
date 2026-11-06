import { createContext, useContext, type ReactNode } from "react";

/** Below this width of the page's own container the toolbar and the summary stack. */
export const USAGE_NARROW_CONTAINER_PX = 720;

/** Chart heights: the compact one when the page's container is narrow. */
export const USAGE_CHART_HEIGHT_PX = 240;
export const USAGE_CHART_HEIGHT_NARROW_PX = 200;

const NarrowContext = createContext(false);

/** The page's container is narrower than the threshold; the sidebar's width is already part of it. */
export function UsageLayoutProvider(props: { narrow: boolean; children: ReactNode }) {
  return <NarrowContext.Provider value={props.narrow}>{props.children}</NarrowContext.Provider>;
}

export function useNarrowLayout(): boolean {
  return useContext(NarrowContext);
}
