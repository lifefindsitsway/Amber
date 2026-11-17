import type { Locator } from "@playwright/test";

/** Effective WCAG contrast of each element's text over what is painted behind it, opacity included. */
export async function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    // The canvas normalises any CSS colour syntax (rgb, oklch, color-mix results) to sRGB.
    const rgba = (css: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r ?? 0, g ?? 0, b ?? 0, (a ?? 0) / 255];
    };
    const over = (top: [number, number, number, number], bottom: [number, number, number]): [number, number, number] => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
    ];
    const layers: Array<[number, number, number, number]> = [];
    let opacity = 1;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      const background = rgba(style.backgroundColor);
      if (background[3] > 0) layers.push(background);
    }
    let backdrop: [number, number, number] = [255, 255, 255];
    for (const layer of layers.reverse()) backdrop = over(layer, backdrop);
    const color = rgba(getComputedStyle(element).color);
    const text = over([color[0], color[1], color[2], color[3] * opacity], backdrop);
    const luminance = (rgb: [number, number, number]): number => {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [light, dark] = [luminance(text), luminance(backdrop)].sort((a, b) => b - a) as [number, number];
    return (light + 0.05) / (dark + 0.05);
  });
}
