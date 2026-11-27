import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PLATFORMS } from "../../../../src/shared/enums.ts";
import { PLATFORM_MARKS, PlatformIcon } from "../../../../src/web/ui/platform-icons/platform-icon.tsx";

/** What SVG path data may hold: the path commands, numbers, signs, dots, commas and white space. */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\- ]+$/u;

describe("PLATFORM_MARKS", () => {
  it("has a mark made of path data only for every platform", () => {
    expect(Object.keys(PLATFORM_MARKS).sort()).toEqual([...PLATFORMS].sort());
    for (const platform of PLATFORMS) {
      const { path, color } = PLATFORM_MARKS[platform];
      expect(path.length).toBeGreaterThan(0);
      expect(path).toMatch(PATH_DATA);
      expect(path.trimStart()).toMatch(/^[Mm]/u);
      if (color !== undefined) expect(color).toMatch(/^#[0-9A-F]{6}$/u);
    }
  });

  it("colours each mark in its brand colour, except Douyin's, which follows the text", () => {
    expect(PLATFORM_MARKS.bilibili.color).toBe("#00A1D6");
    expect(PLATFORM_MARKS.youtube.color).toBe("#FF0000");
    expect(PLATFORM_MARKS.xiaohongshu.color).toBe("#FF2442");
    expect(PLATFORM_MARKS.douyin.color).toBeUndefined();
  });
});

describe("PlatformIcon", () => {
  it("draws a decorative mark that assistive technology skips", () => {
    const { container } = render(
      <div>
        {PLATFORMS.map((platform) => (
          <PlatformIcon key={platform} platform={platform} />
        ))}
      </div>,
    );
    const icons = [...container.querySelectorAll("svg")];
    expect(icons.map((icon) => icon.getAttribute("data-platform-icon"))).toEqual([...PLATFORMS]);
    for (const icon of icons) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(icon.getAttribute("focusable")).toBe("false");
      expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
      // A wordmark is drawn larger so it weighs as much as the pictograms.
      const platform = icon.getAttribute("data-platform-icon") as keyof typeof PLATFORM_MARKS;
      expect(icon.getAttribute("width")).toBe(String(Math.round(20 * (PLATFORM_MARKS[platform].opticalScale ?? 1))));
      expect(icon.querySelectorAll("path")).toHaveLength(1);
      // Nothing a reader would announce or a page could load.
      expect(icon.querySelector("title, script, image, use, a, foreignObject")).toBeNull();
      expect(icon.outerHTML).not.toMatch(/\son\w+=|href=|https?:\/\//u);
    }
    expect(container.textContent).toBe("");
  });

  it("fills Douyin's mark with the text colour and the others with their brand colours", () => {
    const { container } = render(
      <div>
        <PlatformIcon platform="douyin" size={16} />
        <PlatformIcon platform="bilibili" />
      </div>,
    );
    const [douyin, bilibili] = [...container.querySelectorAll("svg")];
    expect(douyin?.getAttribute("fill")).toBe("currentColor");
    expect(douyin?.getAttribute("width")).toBe("16");
    expect(bilibili?.getAttribute("fill")).toBe("#00A1D6");
  });
});
