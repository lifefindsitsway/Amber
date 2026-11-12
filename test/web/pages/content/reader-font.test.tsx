import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderTypography } from "../../../../src/shared/reader-typography.ts";
import { ApiClient } from "../../../../src/web/api/client.ts";
import { resetBundledFonts } from "../../../../src/web/bundled-fonts.ts";
import {
  isLocalFontAvailable,
  READER_CUSTOM_FONT_PROPERTY,
  READER_FONT_ATTRIBUTE,
  useAppliedReaderFont,
  type AppliedReaderFont,
} from "../../../../src/web/pages/content/reader-font.ts";

type Fonts = Pick<ReaderTypography, "font" | "customFont">;

function fakeFonts(): string[] {
  const added: string[] = [];
  class FakeFontFace {
    readonly family: string;
    constructor(family: string) {
      this.family = family;
    }
    load(): Promise<this> {
      return Promise.resolve(this);
    }
  }
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: FakeFontFace) => added.push(face.family) } });
  return added;
}

/** Answers font reads in the order given; each answer is held until `release` is called for it. */
function fontServer(answers: Array<"ok" | "fail"> = []) {
  const calls: string[] = [];
  const held: Array<() => void> = [];
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(url);
    const answer = answers.shift() ?? "ok";
    return new Promise<Response>((resolve) => {
      held.push(() =>
        resolve(answer === "ok" ? new Response(new Uint8Array([1]), { headers: { "content-type": url.endsWith("/kai") ? "font/ttf" : "font/otf" } }) : new Response("", { status: 404 })),
      );
    });
  });
  const release = async (): Promise<void> => {
    await act(async () => {
      held.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return { calls, release };
}

const client = new ApiClient({ baseUrl: "" }, "local");

function applied(initial: Fonts, onBeforeApply?: () => void) {
  return renderHook((fonts: Fonts) => useAppliedReaderFont(fonts, client, onBeforeApply === undefined ? {} : { onBeforeApply }), { initialProps: initial });
}

/** The host element as the reading view renders it, to read what the style sheet would see. */
function Host(props: { font: AppliedReaderFont }) {
  return <div data-testid="host" {...props.font.hostProps} />;
}

beforeEach(() => resetBundledFonts());
afterEach(() => {
  Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useAppliedReaderFont", () => {
  it("leaves the default font untouched: no attribute, no property, no font request", async () => {
    fakeFonts();
    const server = fontServer();
    const { result } = applied({});
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(result.current).toEqual({ font: undefined, key: "default", hostProps: {}, failed: false, loading: false, retry: expect.any(Function) });
    expect(server.calls).toEqual([]);
    const { getByTestId } = render(<Host font={result.current} />);
    const host = getByTestId("host");
    expect(host.getAttributeNames()).toEqual(["data-testid"]);
    expect(host.style.getPropertyValue(READER_CUSTOM_FONT_PROPERTY)).toBe("");
  });

  it("keeps the default while a stored bundled face is read, then switches to it", async () => {
    const added = fakeFonts();
    const server = fontServer();
    // What the view still draws when it is told the switch is coming.
    const drawnAtNotice: string[] = [];
    const { result } = applied({ font: "serif" }, () => drawnAtNotice.push(result.current.key));
    expect(server.calls).toEqual(["/api/fonts/reader/serif"]);
    expect(result.current.font).toBeUndefined();
    expect(result.current.key).toBe("default");
    expect(result.current.loading).toBe(true);
    expect(drawnAtNotice).toEqual([]);
    await server.release();
    await waitFor(() => expect(result.current.font).toBe("serif"));
    expect(drawnAtNotice).toEqual(["default"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.key).toBe("serif");
    expect(result.current.hostProps).toEqual({ [READER_FONT_ATTRIBUTE]: "serif" });
    expect(added).toEqual(["Noto Serif SC"]);
  });

  it("switches at once to a face that is already registered, and reads 黑体 from the subtitle font", async () => {
    fakeFonts();
    const server = fontServer();
    const { result, rerender } = applied({ font: "sans" });
    expect(server.calls).toEqual(["/api/fonts/subtitle"]);
    await server.release();
    await waitFor(() => expect(result.current.font).toBe("sans"));
    rerender({});
    expect(result.current.font).toBeUndefined();
    rerender({ font: "sans" });
    expect(result.current.font).toBe("sans");
    expect(server.calls).toHaveLength(1);
  });

  it("stays in the default and reports the failure when the stored face cannot be read", async () => {
    fakeFonts();
    const server = fontServer(["fail"]);
    const { result } = applied({ font: "kai" });
    await server.release();
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.font).toBeUndefined();
    expect(result.current.hostProps).toEqual({});
  });

  it("shows a new read of a face that failed before as loading, not as failed", async () => {
    fakeFonts();
    const server = fontServer(["fail", "ok"]);
    const { result, rerender } = applied({ font: "kai" });
    await server.release();
    await waitFor(() => expect(result.current.failed).toBe(true));
    rerender({ font: "serif" });
    rerender({ font: "kai" });
    expect(result.current.failed).toBe(false);
    expect(result.current.loading).toBe(true);
  });

  it("reads the stored face again on retry after a failure and then switches to it", async () => {
    fakeFonts();
    const server = fontServer(["fail", "ok"]);
    const onBeforeApply = vi.fn();
    const { result } = applied({ font: "kai" }, onBeforeApply);
    await server.release();
    await waitFor(() => expect(result.current.failed).toBe(true));
    // A failed read draws nothing new, so there is nothing to note.
    expect(onBeforeApply).not.toHaveBeenCalled();
    act(() => result.current.retry());
    expect(result.current.failed).toBe(false);
    expect(result.current.loading).toBe(true);
    await server.release();
    await waitFor(() => expect(result.current.font).toBe("kai"));
    expect(onBeforeApply).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(2);
  });

  it("writes a custom name, quoted, into a custom property on the element and changes the key with the name", async () => {
    fontServer();
    const { result, rerender } = applied({ font: "custom", customFont: "Kaiti SC" });
    expect(result.current.font).toBe("custom");
    expect(result.current.key).toBe("custom:Kaiti SC");
    const { getByTestId, rerender: rerenderHost } = render(<Host font={result.current} />);
    const host = getByTestId("host");
    expect(host.getAttribute(READER_FONT_ATTRIBUTE)).toBe("custom");
    expect(host.style.getPropertyValue(READER_CUSTOM_FONT_PROPERTY)).toBe('"Kaiti SC"');
    rerender({ font: "custom", customFont: "serif" });
    rerenderHost(<Host font={result.current} />);
    expect(host.style.getPropertyValue(READER_CUSTOM_FONT_PROPERTY)).toBe('"serif"');
    expect(result.current.key).toBe("custom:serif");
  });

  it("uses the default for 自选 without a usable name, and keeps a name aside while another font is chosen", () => {
    fontServer();
    expect(applied({ font: "custom" }).result.current.font).toBeUndefined();
    expect(applied({ font: "custom", customFont: "a;b" }).result.current.font).toBeUndefined();
    expect(applied({ customFont: "Kaiti" }).result.current).toEqual({ font: undefined, key: "default", hostProps: {}, failed: false, loading: false, retry: expect.any(Function) });
  });
});

describe("isLocalFontAvailable", () => {
  /** Measures as if only `installed` existed, recording every family list the probe was set in. */
  function layOut(installed: string) {
    const families: string[] = [];
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      families.push(this.style.fontFamily);
      return this.style.fontFamily.startsWith(`"${installed}"`) ? 140 : 100;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => 80);
    return families;
  }

  it("finds a font whose text measures differently from a generic family, and leaves no probe behind", () => {
    const families = layOut("Kaiti SC");
    expect(isLocalFontAvailable("Kaiti SC")).toBe(true);
    expect(families.slice(0, 2)).toEqual(["monospace", '"Kaiti SC", monospace']);
    expect(isLocalFontAvailable("Nothing Here")).toBe(false);
    expect(document.body.children).toHaveLength(0);
  });

  it("does not measure a name the schema refuses", () => {
    const families = layOut("x");
    expect(isLocalFontAvailable('x", serif; color: red')).toBe(false);
    expect(families).toEqual([]);
  });
});
