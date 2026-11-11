import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SpeakerAvatar } from "../../../../../src/web/pages/content/speakers/speaker-avatar.tsx";
import { imageMimeOf } from "../../../../../src/web/pages/content/speakers/use-speaker-avatar.ts";
import { renderApp } from "../../../../fixtures/web/render.tsx";
import { PNG_BYTES, stubFetch, WEBP_BYTES } from "../../../../fixtures/web/speaker-fetch.ts";

const AVATAR_PATH = "/api/contents/c1/speakers/s1/avatar";
const named = { id: "s1", ordinal: 1, colorIndex: 2, name: "陈明" };

describe("SpeakerAvatar letter", () => {
  it("shows the first character of the name on the speaker's colour, named for assistive technology", () => {
    renderApp(<SpeakerAvatar contentId="c1" speaker={named} size={32} />);
    const avatar = screen.getByRole("img", { name: "陈明" });
    expect(avatar.textContent).toBe("陈");
    expect(avatar.dataset["kind"]).toBe("monogram");
    expect(avatar.style.backgroundColor).toBe("var(--speaker-2-bg)");
    expect(avatar.style.color).toBe("var(--speaker-2-fg)");
    expect(avatar.style.getPropertyValue("--speaker-size")).toBe("32px");
  });

  it("upper-cases a Latin initial and keeps an emoji cluster whole", () => {
    renderApp(
      <>
        <SpeakerAvatar contentId="c1" speaker={{ ...named, id: "a", name: "alice" }} testId="a" />
        <SpeakerAvatar contentId="c1" speaker={{ ...named, id: "b", name: "👩‍🔬 Lin" }} testId="b" />
      </>,
    );
    expect(screen.getByTestId("a").textContent).toBe("A");
    expect(screen.getByTestId("b").textContent).toBe("👩‍🔬");
  });

  it("numbers an unnamed speaker by its ordinal and says so in its name", () => {
    renderApp(<SpeakerAvatar contentId="c1" speaker={{ id: "s3", ordinal: 3, colorIndex: 0 }} />);
    const avatar = screen.getByRole("img", { name: "发言人 3" });
    expect(avatar.textContent).toBe("3");
  });

  it("draws the unassigned variant as a neutral dashed circle named 「未分配」", () => {
    renderApp(<SpeakerAvatar unassigned />);
    const avatar = screen.getByRole("img", { name: "未分配" });
    expect(avatar.dataset["kind"]).toBe("unassigned");
    expect(avatar.className).toContain("border-dashed");
    expect(avatar.textContent).toBe("");
  });

  it("scales with the text in the reader and is smaller and quieter when muted", () => {
    renderApp(
      <>
        <SpeakerAvatar contentId="c1" speaker={named} size="em" testId="em" />
        <SpeakerAvatar contentId="c1" speaker={named} size={40} variant="muted" testId="muted" />
      </>,
    );
    expect(screen.getByTestId("em").style.getPropertyValue("--speaker-size")).toBe("clamp(28px, 1.75em, 48px)");
    const muted = screen.getByTestId("muted");
    expect(Number.parseInt(muted.style.getPropertyValue("--speaker-size"), 10)).toBeLessThan(40);
    expect(muted.className).toContain("opacity-70");
  });

  it("is hidden from assistive technology when the name is written beside it", () => {
    renderApp(<SpeakerAvatar contentId="c1" speaker={named} decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("speaker-avatar").getAttribute("aria-hidden")).toBe("true");
  });
});

describe("SpeakerAvatar photo", () => {
  it("fetches the photo through the authenticated client, not through an image URL", async () => {
    const calls = stubFetch({ [`GET ${AVATAR_PATH}`]: { bytes: WEBP_BYTES, type: "image/webp" } });
    renderApp(<SpeakerAvatar contentId="c1" speaker={{ ...named, avatarVersion: 4 }} />, { endpoint: { baseUrl: "", token: "sidecar-token" }, mode: "local" });
    await waitFor(() => expect(screen.getByTestId("speaker-avatar").dataset["kind"]).toBe("photo"));
    const image = screen.getByTestId("speaker-avatar").querySelector("img");
    expect(image?.getAttribute("src")).toMatch(/^data:image\/webp;base64,/);
    expect(image?.getAttribute("alt")).toBe("");
    const call = calls.find((item) => item.path === AVATAR_PATH);
    expect(call?.headers["authorization"]).toBe("Bearer sidecar-token");
    expect(call?.headers["accept"]).toBe("image/webp, image/png, image/jpeg");
  });

  it("asks for nothing when the speaker has no photo", () => {
    const calls = stubFetch({});
    renderApp(<SpeakerAvatar contentId="c1" speaker={named} />);
    expect(calls).toHaveLength(0);
  });

  it("falls back to the letter when the photo cannot be fetched", async () => {
    const calls = stubFetch({ [`GET ${AVATAR_PATH}`]: { status: 404, json: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } } });
    renderApp(<SpeakerAvatar contentId="c1" speaker={{ ...named, avatarVersion: 1 }} />);
    await waitFor(() => expect(calls.some((item) => item.path === AVATAR_PATH)).toBe(true));
    await act(async () => undefined);
    expect(screen.getByTestId("speaker-avatar").dataset["kind"]).toBe("monogram");
    expect(screen.getByTestId("speaker-avatar").textContent).toBe("陈");
  });

  it("falls back to the letter when the bytes are not an image", async () => {
    stubFetch({ [`GET ${AVATAR_PATH}`]: { bytes: new Uint8Array([1, 2, 3, 4]), type: "image/webp" } });
    renderApp(<SpeakerAvatar contentId="c1" speaker={{ ...named, avatarVersion: 1 }} />);
    await act(async () => undefined);
    await act(async () => undefined);
    expect(screen.getByTestId("speaker-avatar").dataset["kind"]).toBe("monogram");
  });

  it("falls back to the letter when the browser cannot decode the picture", async () => {
    stubFetch({ [`GET ${AVATAR_PATH}`]: { bytes: WEBP_BYTES } });
    renderApp(<SpeakerAvatar contentId="c1" speaker={{ ...named, avatarVersion: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("speaker-avatar").dataset["kind"]).toBe("photo"));
    fireEvent.error(screen.getByTestId("speaker-avatar").querySelector("img") as HTMLImageElement);
    expect(screen.getByTestId("speaker-avatar").dataset["kind"]).toBe("monogram");
  });

  it("fetches again when the photo's version changes and not when it stays", async () => {
    const calls = stubFetch({ [`GET ${AVATAR_PATH}`]: () => ({ bytes: WEBP_BYTES }) });
    function Harness() {
      const [version, setVersion] = useState(1);
      const [, setTick] = useState(0);
      return (
        <>
          <button onClick={() => setVersion(2)}>new photo</button>
          <button onClick={() => setTick((tick) => tick + 1)}>rerender</button>
          <SpeakerAvatar contentId="c1" speaker={{ ...named, avatarVersion: version }} />
        </>
      );
    }
    renderApp(<Harness />);
    await waitFor(() => expect(screen.getByTestId("speaker-avatar").dataset["kind"]).toBe("photo"));
    fireEvent.click(screen.getByText("rerender"));
    await act(async () => undefined);
    expect(calls.filter((item) => item.path === AVATAR_PATH)).toHaveLength(1);
    fireEvent.click(screen.getByText("new photo"));
    await waitFor(() => expect(calls.filter((item) => item.path === AVATAR_PATH)).toHaveLength(2));
  });

  it("shows a given picture (an unsaved crop) without asking the server", () => {
    const calls = stubFetch({});
    renderApp(<SpeakerAvatar contentId="c1" speaker={{ ...named, avatarVersion: 9 }} photoUrl="data:image/png;base64,AAAA" />);
    expect(screen.getByTestId("speaker-avatar").querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(calls).toHaveLength(0);
  });
});

describe("imageMimeOf", () => {
  it("decides the type from the file header", () => {
    expect(imageMimeOf(WEBP_BYTES)).toBe("image/webp");
    expect(imageMimeOf(PNG_BYTES)).toBe("image/png");
    expect(imageMimeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe("image/jpeg");
    expect(imageMimeOf(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeUndefined();
    expect(imageMimeOf(new Uint8Array())).toBeUndefined();
  });
});
