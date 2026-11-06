import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * The content box of an element, kept current by a `ResizeObserver`. Where nothing can be
 * measured (no layout engine, hidden element) the fallback is returned, so a chart still
 * renders something sensible and tests stay deterministic.
 */
export function useElementSize<T extends HTMLElement>(fallback: ElementSize): [RefObject<T | null>, ElementSize] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>(fallback);
  const fallbackWidth = fallback.width;
  const fallbackHeight = fallback.height;
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const read = (width: number, height: number): void => {
      const next = { width: width > 0 ? width : fallbackWidth, height: height > 0 ? height : fallbackHeight };
      setSize((previous) => (previous.width === next.width && previous.height === next.height ? previous : next));
    };
    read(element.clientWidth, element.clientHeight);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) read(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallbackWidth, fallbackHeight]);
  return [ref, size];
}
