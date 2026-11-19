import type { ReactNode } from "react";

/**
 * What the `<video>` player tells a feature that draws on it or adds a control. `picture` is
 * the rectangle the picture really fills inside the player (letterboxing excluded), in CSS
 * pixels from the player's top left; `container` is the player root, where menus portal so
 * they stay visible in fullscreen. A feature reports its menu opening through
 * `onMenuOpenChange`, so the controls stay shown meanwhile.
 */
export interface PlayerExtensionContext {
  video: HTMLVideoElement | null;
  picture: { x: number; y: number; width: number; height: number };
  audioOnly: boolean;
  fullscreen: boolean;
  playing: boolean;
  /** The media asset the player shows, when the page named one (a cached quality). */
  sourceId: string | undefined;
  container: HTMLElement | null;
  onMenuOpenChange: (open: boolean) => void;
}

/**
 * Features the content page adds to the `<video>` player without the player knowing them:
 * `pictureLayers` draw over the picture and under the subtitles (danmaku); `controls` are
 * buttons in the control bar's right group, before the volume (danmaku, frame capture);
 * `settingsItems` are entries at the end of the settings menu, where a feature goes when the
 * control bar (as wide as the video box) is too narrow for its button. Each returns `null` when
 * it has nothing to show for this context.
 */
export interface PlayerExtensions {
  pictureLayers?: (context: PlayerExtensionContext) => ReactNode;
  controls?: (context: PlayerExtensionContext) => ReactNode;
  /** Rendered inside the settings menu (a Radix dropdown): use `DropdownMenu.Item` and friends. */
  settingsItems?: (context: PlayerExtensionContext) => ReactNode;
}
