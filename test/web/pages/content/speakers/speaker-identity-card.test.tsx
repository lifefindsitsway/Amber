import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SPEAKER_NAME_MAX_GRAPHEMES, SPEAKER_PALETTE_SIZE } from "../../../../../src/shared/defaults.ts";
import type { SpeakerDto } from "../../../../../src/shared/dto/speaker.ts";
import { shareLine, SpeakerIdentityCard } from "../../../../../src/web/pages/content/speakers/speaker-identity-card.tsx";
import { renderApp } from "../../../../fixtures/web/render.tsx";
import { stubFetch, stubResizeObserver, type FetchCall } from "../../../../fixtures/web/speaker-fetch.ts";

const speaker: SpeakerDto = { id: "s1", ordinal: 1, name: "陈明", colorIndex: 0, used: true };

function card(overrides: Partial<SpeakerDto> = {}, extra: { sentences?: number; durationShare?: number } = {}) {
  return (
    <SpeakerIdentityCard contentId="c1" speaker={{ ...speaker, ...overrides }} sentences={extra.sentences ?? 42} durationShare={extra.durationShare ?? 0.376}>
      <span>陈明</span>
    </SpeakerIdentityCard>
  );
}

const patched = (call: FetchCall): boolean => call.method === "PATCH";

beforeEach(() => {
  stubResizeObserver();
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe("shareLine", () => {
  const t = ((key: string, options?: Record<string, unknown>) => `${key}:${JSON.stringify(options ?? {})}`) as never;

  it("joins the sentence count and the rounded share", () => {
    expect(shareLine(t, 42, 0.376)).toBe('speakerIdentity.card.shareSentences:{"count":42} · speakerIdentity.card.shareDuration:{"percent":38}');
  });

  it("says less than 1% instead of 0%, and leaves out what is not known", () => {
    expect(shareLine(t, undefined, 0.002)).toContain("shareDurationLow");
    expect(shareLine(t, undefined, 0)).toContain('"percent":0');
    expect(shareLine(t, undefined, undefined)).toBe("");
  });
});

describe("SpeakerIdentityCard", () => {
  it("opens from its button, shows who the speaker is and how much they speak, and closes with Escape back to the trigger", async () => {
    renderApp(card());
    const trigger = screen.getByTestId("speaker-trigger");
    // A native button, so Enter and Space reach it as a click.
    expect(trigger.tagName).toBe("BUTTON");
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByTestId("speaker-card");
    expect(screen.getByTestId("speaker-popover").getAttribute("aria-label")).toBe("发言人信息：陈明");
    expect(within(dialog).getByTestId("speaker-card-name").textContent).toBe("陈明");
    expect(within(dialog).getByTestId("speaker-card-share").textContent).toBe("42 句 · 约占 38% 时长");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("speaker-card")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("names an unnamed speaker by its ordinal", async () => {
    const { name: _name, ...unnamed } = speaker;
    void _name;
    renderApp(
      <SpeakerIdentityCard contentId="c1" speaker={{ ...unnamed, ordinal: 4 }}>
        <span>x</span>
      </SpeakerIdentityCard>,
    );
    fireEvent.click(screen.getByTestId("speaker-trigger"));
    expect((await screen.findByTestId("speaker-card-name")).textContent).toBe("发言人 4");
    // Without figures the share line is left out rather than empty.
    expect(screen.queryByTestId("speaker-card-share")).toBeNull();
  });

  it("turns into the edit form with 「编辑」 and back to the card when the form is cancelled", async () => {
    renderApp(card());
    fireEvent.click(screen.getByTestId("speaker-trigger"));
    fireEvent.click(await screen.findByTestId("speaker-card-edit"));
    expect(await screen.findByTestId("speaker-edit-form")).toBeTruthy();
    expect(screen.queryByTestId("speaker-card")).toBeNull();
    fireEvent.click(screen.getByTestId("speaker-edit-cancel"));
    expect(await screen.findByTestId("speaker-card")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("speaker-card-edit")));
  });

  it("keeps the form's actions pinned to the bottom of the scrolling panel, as its last part", async () => {
    renderApp(card());
    fireEvent.click(screen.getByTestId("speaker-trigger"));
    fireEvent.click(await screen.findByTestId("speaker-card-edit"));
    const form = await screen.findByTestId("speaker-edit-form");
    const actions = screen.getByTestId("speaker-edit-actions");
    // The panel is the scroll container; a short window scrolls it, and the actions stay in view.
    expect(screen.getByTestId("speaker-popover").className).toContain("overflow-y-auto");
    expect(form.lastElementChild).toBe(actions);
    expect(actions.className).toContain("sticky");
    expect(actions.className).toContain("bottom-0");
    expect(within(actions).getByTestId("speaker-edit-save")).toBeTruthy();
    expect(within(actions).getByTestId("speaker-edit-cancel")).toBeTruthy();
  });
});

describe("SpeakerEditForm", () => {
  async function openForm(overrides: Partial<SpeakerDto> = {}, routes: Parameters<typeof stubFetch>[0] = {}) {
    const calls = stubFetch({
      "GET /api/speakers/suggestions": { json: { items: [] } },
      "PATCH /api/contents/c1/speakers/s1": { json: { ...speaker, ...overrides, name: "新名字" } },
      ...routes,
    });
    renderApp(card(overrides));
    fireEvent.click(screen.getByTestId("speaker-trigger"));
    fireEvent.click(await screen.findByTestId("speaker-card-edit"));
    await screen.findByTestId("speaker-edit-form");
    return calls;
  }

  it("starts on the name, selected, with the live counter", async () => {
    await openForm();
    const input = screen.getByTestId("speaker-name-input") as HTMLInputElement;
    expect(input.value).toBe("陈明");
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId("speaker-name-counter").textContent).toBe(`2/${SPEAKER_NAME_MAX_GRAPHEMES}`);
    fireEvent.change(input, { target: { value: "👩‍🔬 Lin" } });
    // An emoji cluster is one character, as the limit counts them.
    expect(screen.getByTestId("speaker-name-counter").textContent).toBe(`5/${SPEAKER_NAME_MAX_GRAPHEMES}`);
  });

  it("counts the cleaned name, so a name that saves never shows more than the limit", async () => {
    await openForm();
    const padded = `${"字".repeat(SPEAKER_NAME_MAX_GRAPHEMES)}\u202E  `;
    fireEvent.change(screen.getByTestId("speaker-name-input"), { target: { value: padded } });
    expect(screen.getByTestId("speaker-name-counter").textContent).toBe(`${SPEAKER_NAME_MAX_GRAPHEMES}/${SPEAKER_NAME_MAX_GRAPHEMES}`);
    expect((screen.getByTestId("speaker-edit-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses a name past the limit instead of cutting it", async () => {
    await openForm();
    fireEvent.change(screen.getByTestId("speaker-name-input"), { target: { value: "字".repeat(SPEAKER_NAME_MAX_GRAPHEMES + 1) } });
    expect(screen.getByRole("alert").textContent).toContain(String(SPEAKER_NAME_MAX_GRAPHEMES));
    expect(screen.getByTestId("speaker-name-input").getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByTestId("speaker-edit-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers 「保存」 for a name that is not confirmed yet and confirms it as it is", async () => {
    const calls = await openForm();
    const save = screen.getByTestId("speaker-edit-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some(patched)).toBe(true));
    expect(calls.find(patched)?.body).toEqual({ name: "陈明", nameConfirmed: true });
  });

  it("keeps 「保存」 off until something changed, then sends only what changed, normalized, a name as confirmed", async () => {
    const calls = await openForm({ nameConfirmed: true });
    // Saving a name is what lets AI use it, and the form says so.
    expect(screen.getByTestId("speaker-name-confirm-hint").textContent).toBe("保存后 AI 将以此姓名称呼该发言人");
    const save = screen.getByTestId("speaker-edit-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("speaker-name-input"), { target: { value: "  新名字‮  " } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some(patched)).toBe(true));
    expect(calls.find(patched)?.body).toEqual({ name: "新名字", nameConfirmed: true });
  });

  it("sends null for a blank name, which makes the speaker unnamed", async () => {
    const calls = await openForm();
    fireEvent.change(screen.getByTestId("speaker-name-input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("speaker-edit-save"));
    await waitFor(() => expect(calls.some(patched)).toBe(true));
    expect(calls.find(patched)?.body).toEqual({ name: null });
  });

  it("offers the whole palette as named radio swatches and sends the chosen colour", async () => {
    const calls = await openForm({ nameConfirmed: true });
    const group = screen.getByRole("radiogroup", { name: "颜色" });
    const swatches = within(group).getAllByRole("radio");
    expect(swatches).toHaveLength(SPEAKER_PALETTE_SIZE);
    expect(new Set(swatches.map((swatch) => swatch.getAttribute("aria-label"))).size).toBe(SPEAKER_PALETTE_SIZE);
    expect(swatches[0]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(swatches[3] as HTMLElement);
    expect(swatches[3]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("speaker-edit-save"));
    await waitFor(() => expect(calls.some(patched)).toBe(true));
    expect(calls.find(patched)?.body).toEqual({ colorIndex: 3 });
  });

  it("removes the stored photo", async () => {
    const calls = await openForm({ avatarVersion: 3, nameConfirmed: true }, { "GET /api/contents/c1/speakers/s1/avatar": { status: 404, json: {} } });
    fireEvent.click(screen.getByTestId("speaker-photo-remove"));
    fireEvent.click(screen.getByTestId("speaker-edit-save"));
    await waitFor(() => expect(calls.some(patched)).toBe(true));
    expect(calls.find(patched)?.body).toEqual({ avatar: null });
  });

  it("copies a suggested speaker from another Content and closes the form", async () => {
    const calls = await openForm(
      {},
      {
        "GET /api/speakers/suggestions": {
          json: { items: [{ contentId: "c9", speakerId: "z1", name: "李雪", colorIndex: 5, contentTitle: "上一期访谈" }] },
        },
      },
    );
    const option = await screen.findByTestId("speaker-suggestion");
    expect(option.textContent).toContain("李雪");
    expect(option.textContent).toContain("上一期访谈");
    fireEvent.click(option);
    await waitFor(() => expect(calls.some(patched)).toBe(true));
    expect(calls.find(patched)?.body).toEqual({ copyFrom: { contentId: "c9", speakerId: "z1" }, nameConfirmed: true });
    expect(await screen.findByTestId("speaker-card")).toBeTruthy();
  });

  it("asks for suggestions matching the typed name, after a pause", async () => {
    const calls = await openForm();
    fireEvent.change(screen.getByTestId("speaker-name-input"), { target: { value: "李" } });
    await waitFor(() => expect(calls.some((call) => call.path === "/api/speakers/suggestions?q=%E6%9D%8E&contentId=c1")).toBe(true));
  });

  it("shows the server's explanation when saving fails and keeps the form", async () => {
    await openForm(
      {},
      {
        "PATCH /api/contents/c1/speakers/s1": { status: 400, json: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "名字不合法" } } },
      },
    );
    fireEvent.change(screen.getByTestId("speaker-name-input"), { target: { value: "新" } });
    fireEvent.click(screen.getByTestId("speaker-edit-save"));
    expect(await screen.findByText("名字不合法")).toBeTruthy();
    expect(screen.getByTestId("speaker-edit-form")).toBeTruthy();
    await act(async () => undefined);
  });

  it("closes on Escape from inside the form and returns focus to the trigger", async () => {
    await openForm();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("speaker-edit-form")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("speaker-trigger"));
  });
});

describe("photo choosing", () => {
  it("crops a chosen photo, previews it and uploads it re-encoded", async () => {
    stubResizeObserver();
    const calls = stubFetch({
      "GET /api/speakers/suggestions": { json: { items: [] } },
      "PATCH /api/contents/c1/speakers/s1": { json: speaker },
    });
    vi.stubGlobal("createImageBitmap", async (_file: File, options: ImageBitmapOptions) => ({ width: options.resizeHeight === undefined ? 64 : (options.resizeWidth ?? 0), height: options.resizeHeight ?? 48, close: () => undefined }));
    const context = { clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingQuality: "low" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback: BlobCallback, type?: string) {
      callback(new Blob([new Uint8Array([1, 2, 3, 4])], { type: type ?? "" }));
    } as never);
    renderApp(card({ nameConfirmed: true }));
    fireEvent.click(screen.getByTestId("speaker-trigger"));
    fireEvent.click(await screen.findByTestId("speaker-card-edit"));
    const input = (await screen.findByTestId("speaker-photo-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "me.jpg", { type: "image/jpeg" })] } });
    const area = await screen.findByTestId("speaker-crop-area");
    // The arrow keys move the photo under the circle; the slider zooms.
    fireEvent.keyDown(area, { key: "ArrowLeft" });
    fireEvent.change(screen.getByTestId("speaker-crop-zoom"), { target: { value: "2" } });
    expect((screen.getByTestId("speaker-edit-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("speaker-crop-confirm"));
    await waitFor(() => expect(screen.queryByTestId("speaker-cropper")).toBeNull());
    expect(screen.getByTestId("speaker-edit-preview").dataset["kind"]).toBe("photo");
    fireEvent.click(screen.getByTestId("speaker-edit-save"));
    await waitFor(() => expect(calls.some(patched)).toBe(true));
    expect(calls.find(patched)?.body).toEqual({ avatar: { data: "AQIDBA==", mime: "image/webp" } });
  });

  it("explains a file that cannot be read", async () => {
    stubResizeObserver();
    stubFetch({ "GET /api/speakers/suggestions": { json: { items: [] } } });
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("bad");
    });
    class BrokenImage {
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    renderApp(card());
    fireEvent.click(screen.getByTestId("speaker-trigger"));
    fireEvent.click(await screen.findByTestId("speaker-card-edit"));
    fireEvent.change(await screen.findByTestId("speaker-photo-input"), { target: { files: [new File(["x"], "me.svg", { type: "image/svg+xml" })] } });
    expect((await screen.findByRole("alert")).textContent).toContain("无法读取");
  });
});
