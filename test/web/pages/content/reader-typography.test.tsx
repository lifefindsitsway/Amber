import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { READER_FONT_SIZE_DEFAULT, READER_FONT_SIZE_MAX, READER_LINE_HEIGHT_DEFAULT } from "../../../../src/shared/defaults.ts";
import {
  parseReaderTypography,
  READER_TYPOGRAPHY_DEFAULTS,
  useReaderTypography,
  type ReaderTypography,
} from "../../../../src/web/pages/content/reader-typography.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const ME = { userId: "u1", role: "user", mode: "server", mustChangePassword: false };
const KEY = "amber.reader.typography.u1";

let api: ReturnType<typeof useReaderTypography> | undefined;

function Probe() {
  api = useReaderTypography();
  const [value] = api;
  return <p data-testid="value">{JSON.stringify(value)}</p>;
}

function current(): ReaderTypography {
  if (api === undefined) throw new Error("not mounted");
  return api[0];
}

async function mountSignedIn(): Promise<void> {
  mockApi({ "GET /api/auth/me": { body: ME } });
  renderApp(<Probe />);
  await waitFor(() => expect(screen.getByTestId("value")).toBeTruthy());
  // The current user arrives asynchronously; writes need it.
  await waitFor(() => {
    act(() => api?.[1]({}));
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });
  act(() => api?.[2]());
}

beforeEach(() => {
  localStorage.clear();
  api = undefined;
});

describe("parseReaderTypography", () => {
  it("returns the defaults for a missing, unparsable or non-object value", () => {
    for (const raw of [undefined, "{broken", "null", "[1]", "7"]) {
      expect(parseReaderTypography(raw)).toEqual(READER_TYPOGRAPHY_DEFAULTS);
    }
  });

  it("falls back field by field and keeps the valid fields", () => {
    expect(parseReaderTypography(JSON.stringify({ version: 1, fontSize: 40, lineHeight: 1.8, showSpeakers: false }))).toEqual({
      ...READER_TYPOGRAPHY_DEFAULTS,
      lineHeight: 1.8,
      showSpeakers: false,
    });
    expect(parseReaderTypography(JSON.stringify({ fontSize: 24, lineHeight: 9, showSpeakers: 1 }))).toEqual({ ...READER_TYPOGRAPHY_DEFAULTS, fontSize: 24 });
  });
});

describe("useReaderTypography", () => {
  it("starts from the defaults and stores a merged change under the user's key", async () => {
    await mountSignedIn();
    expect(current()).toEqual(READER_TYPOGRAPHY_DEFAULTS);
    act(() => api?.[1]({ fontSize: 24 }));
    expect(current()).toEqual({ ...READER_TYPOGRAPHY_DEFAULTS, fontSize: 24 });
    act(() => api?.[1]({ showSpeakers: false }));
    expect(current()).toEqual({ ...READER_TYPOGRAPHY_DEFAULTS, fontSize: 24, showSpeakers: false });
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual({ version: 1, fontSize: 24, lineHeight: READER_LINE_HEIGHT_DEFAULT, showSpeakers: false });
  });

  it("reads a stored value, using the defaults for damaged fields", async () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, fontSize: 99, lineHeight: 2, showSpeakers: false }));
    mockApi({ "GET /api/auth/me": { body: ME } });
    renderApp(<Probe />);
    await waitFor(() => expect(current()).toEqual({ version: 1, fontSize: READER_FONT_SIZE_DEFAULT, lineHeight: 2, showSpeakers: false }));
  });

  it("applies two changes made in the same tick", async () => {
    await mountSignedIn();
    act(() => {
      api?.[1]({ fontSize: 28 });
      api?.[1]({ lineHeight: 2 });
    });
    expect(current()).toEqual({ ...READER_TYPOGRAPHY_DEFAULTS, fontSize: 28, lineHeight: 2 });
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual({ version: 1, fontSize: 28, lineHeight: 2, showSpeakers: true });
  });

  it("ignores a change that would leave the allowed values", async () => {
    await mountSignedIn();
    act(() => api?.[1]({ fontSize: READER_FONT_SIZE_MAX + 1 }));
    expect(current()).toEqual(READER_TYPOGRAPHY_DEFAULTS);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("restores the defaults and removes the stored value on reset", async () => {
    await mountSignedIn();
    act(() => api?.[1]({ fontSize: 28, lineHeight: 2 }));
    expect(localStorage.getItem(KEY)).not.toBeNull();
    act(() => api?.[2]());
    expect(current()).toEqual(READER_TYPOGRAPHY_DEFAULTS);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("writes nothing while the current user is unknown", async () => {
    mockApi({ "GET /api/auth/me": { status: 401, body: { error: { class: "unauthenticated", code: "unauthenticated.session", retryDisposition: "never", userMessage: "" } } } });
    renderApp(<Probe />);
    await waitFor(() => expect(screen.getByTestId("value")).toBeTruthy());
    act(() => api?.[1]({ fontSize: 28 }));
    expect(current()).toEqual(READER_TYPOGRAPHY_DEFAULTS);
    expect(localStorage.length).toBe(0);
  });
});
