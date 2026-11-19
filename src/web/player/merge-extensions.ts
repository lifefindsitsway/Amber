import { createElement, Fragment, type ReactNode } from "react";
import type { PlayerExtensionContext, PlayerExtensions } from "./player-extensions.ts";

/** Combines several features' player extensions, in order; `undefined` when none has any. */
export function mergeExtensions(...parts: ReadonlyArray<PlayerExtensions | undefined>): PlayerExtensions | undefined {
  const present = parts.filter((part): part is PlayerExtensions => part !== undefined);
  if (present.length <= 1) return present[0];
  const layers = present.flatMap((part) => (part.pictureLayers === undefined ? [] : [part.pictureLayers]));
  const controls = present.flatMap((part) => (part.controls === undefined ? [] : [part.controls]));
  const settingsItems = present.flatMap((part) => (part.settingsItems === undefined ? [] : [part.settingsItems]));
  // Parts that render nothing are dropped, so an all-empty result is `null` and a container
  // (the settings menu's separator) can tell there is nothing to show.
  const all = (renderers: ReadonlyArray<(context: PlayerExtensionContext) => ReactNode>) => (context: PlayerExtensionContext) => {
    const rendered = renderers
      .map((render, index) => ({ index, node: render(context) }))
      .filter(({ node }) => node !== null && node !== undefined && node !== false)
      .map(({ index, node }) => createElement(Fragment, { key: index }, node));
    return rendered.length === 0 ? null : rendered;
  };
  return {
    ...(layers.length === 0 ? {} : { pictureLayers: all(layers) }),
    ...(controls.length === 0 ? {} : { controls: all(controls) }),
    ...(settingsItems.length === 0 ? {} : { settingsItems: all(settingsItems) }),
  };
}
