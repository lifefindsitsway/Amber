import { act, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIGURES_PER_CONTENT_MAX } from "../../../../src/shared/defaults.ts";
import { figureUploadMetaSchema } from "../../../../src/shared/dto/figure.ts";
import { figureInsertStatus } from "../../../../src/web/pages/content/figure-insert.ts";
import { imagePasteDecision, pastedImage, useFigurePaste } from "../../../../src/web/pages/content/figure-paste.ts";
import { usePasteGuard } from "../../../../src/web/shell/paste-guard.ts";
import { figure, FigurePage, pngFile, steeredApi, targetAfter } from "../../../fixtures/web/figure-insert.tsx";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

const LINK = "https://www.bilibili.com/video/BV1xx411c7mD";

afterEach(() => figureInsertStatus.clear());

/** A clipboard as a paste event carries it: text, and file items. */
function clipboard(input: { text?: string; files?: File[] }) {
  const files = input.files ?? [];
  return {
    getData: (type: string) => (type === "text/plain" ? (input.text ?? "") : ""),
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
  };
}

function paste(input: { text?: string; files?: File[] }): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboard(input) });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function Page() {
  usePasteGuard();
  useFigurePaste();
  return <Where />;
}

function show(api: ReturnType<typeof steeredApi>["api"] | undefined) {
  const server = mockApi({
    "GET /api/contents/c1/figures": { body: { items: [], recentlyDeleted: [], limit: FIGURES_PER_CONTENT_MAX } },
    "POST /api/contents/c1/figures/upload": { status: 201, body: figure({ id: "PASTED" }) },
  });
  renderApp(
    <FigurePage api={api}>
      <Page />
    </FigurePage>,
    { route: "/contents/c1" },
  );
  return server;
}

const uploads = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST" && call.path.endsWith("/figures/upload"));

describe("pastedImage", () => {
  it("takes the first image file of the clipboard, and nothing from text alone", () => {
    const image = pngFile();
    expect(pastedImage(clipboard({ text: "字" }) as unknown as DataTransfer)).toBeUndefined();
    expect(pastedImage(clipboard({ files: [new File(["x"], "a.txt", { type: "text/plain" }), image] }) as unknown as DataTransfer)).toBe(image);
    expect(pastedImage(undefined)).toBeUndefined();
    expect(pastedImage({ items: undefined } as unknown as DataTransfer)).toBeUndefined();
  });
});

describe("imagePasteDecision", () => {
  const { api } = steeredApi(targetAfter("s2", 20_000));
  const image = pngFile();

  it("inserts after the current paragraph, taken at the press", () => {
    expect(imagePasteDecision({ activeElement: document.body, dialogOpen: false, api, image })).toEqual({ file: image, target: targetAfter("s2", 20_000) });
  });

  it("leaves a paste into a field, under a dialog, without a reading view or without an image alone", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    expect(imagePasteDecision({ activeElement: document.createElement("input"), dialogOpen: false, api, image })).toBeUndefined();
    expect(imagePasteDecision({ activeElement: document.createElement("textarea"), dialogOpen: false, api, image })).toBeUndefined();
    expect(imagePasteDecision({ activeElement: editor, dialogOpen: false, api, image })).toBeUndefined();
    expect(imagePasteDecision({ activeElement: document.body, dialogOpen: true, api, image })).toBeUndefined();
    expect(imagePasteDecision({ activeElement: document.body, dialogOpen: false, api: undefined, image })).toBeUndefined();
    expect(imagePasteDecision({ activeElement: document.body, dialogOpen: false, api, image: undefined })).toBeUndefined();
  });
});

describe("useFigurePaste with the link paste", () => {
  it("inserts a pasted image once, at the paragraph current at the press", async () => {
    const { api, state } = steeredApi(targetAfter("s4", 40_000));
    const server = show(api);
    const event = paste({ files: [pngFile()] });
    // Playback moves on right after the press; the place stays.
    state.target = targetAfter("s8", 80_000);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(uploads(server.calls)).toHaveLength(1));
    const meta = figureUploadMetaSchema.parse(JSON.parse(uploads(server.calls)[0]?.form?.[0]?.[1] as string));
    expect(meta.placement).toEqual(targetAfter("s4", 40_000).placement);
    await waitFor(() => expect(api.revealFigure).toHaveBeenCalledWith("PASTED"));
    expect(api.captureTarget).toHaveBeenCalledTimes(1);
  });

  it("follows a supported link instead when the clipboard holds an image too: one paste, one action", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    const server = show(api);
    const event = paste({ text: LINK, files: [pngFile()] });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/new"));
    expect(uploads(server.calls)).toHaveLength(0);
    expect(api.captureTarget).not.toHaveBeenCalled();
  });

  it("leaves the paste alone in a field or under a dialog", () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    const server = show(api);
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    expect(paste({ files: [pngFile()] }).defaultPrevented).toBe(false);
    field.remove();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    expect(paste({ files: [pngFile()] }).defaultPrevented).toBe(false);
    dialog.remove();
    expect(uploads(server.calls)).toHaveLength(0);
  });

  it("does nothing without a reading view that can take figures", () => {
    const server = show(undefined);
    expect(paste({ files: [pngFile()] }).defaultPrevented).toBe(false);
    expect(uploads(server.calls)).toHaveLength(0);
  });

  it("says why a pasted image of another kind cannot be taken, without sending it", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    const server = show(api);
    const status: string[] = [];
    const stop = figureInsertStatus.subscribe(() => {
      for (const shown of figureInsertStatus.list("c1", "reader")) if (shown.phase === "failed" && !status.includes(shown.message)) status.push(shown.message);
    });
    try {
      expect(paste({ files: [new File(["GIF89a"], "动图.gif", { type: "image/gif" })] }).defaultPrevented).toBe(true);
      await waitFor(() => expect(status).toEqual(["只支持 PNG、JPEG、WebP 图片"]));
      expect(uploads(server.calls)).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("cancels an upload under way when the page is left, and its late answer says nothing", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_input: string, init: RequestInit = {}) => {
      if (init.method === "POST") {
        signal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [], recentlyDeleted: [], limit: FIGURES_PER_CONTENT_MAX }), { headers: { "content-type": "application/json" } }));
    });
    const view = renderApp(
      <FigurePage api={api}>
        <Page />
      </FigurePage>,
      { route: "/contents/c1" },
    );
    paste({ files: [pngFile()] });
    await waitFor(() => expect(figureInsertStatus.pending("c1", "reader")).toBe(true));
    view.unmount();
    expect(signal?.aborted).toBe(true);
    // The aborted request settles after the page is gone: nothing is said about it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(figureInsertStatus.snapshot()).toEqual([]);
  });
});

