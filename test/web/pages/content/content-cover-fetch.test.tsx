import { useQuery } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApi } from "../../../../src/web/api/context.tsx";
import { queryKeys } from "../../../../src/web/api/queries.ts";
import { CoverFetchStatus, useCoverFetch } from "../../../../src/web/pages/content/content-cover-fetch.tsx";
import { useContentDetail } from "../../../../src/web/pages/content/content-data.ts";
import { contentDetail } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

const FETCH = "POST /api/contents/c1/cover/fetch";

/** The menu entry, the status line, the detail's cover version and a list that shows covers, as the page has them. */
function Harness() {
  const client = useApi();
  const cover = useCoverFetch("c1");
  const detail = useContentDetail("c1");
  // Stands for the library list: refreshed so its rows pick up the new version.
  useQuery({ queryKey: queryKeys.contents({}), queryFn: () => client.get("/api/contents", z.unknown()) });
  return (
    <>
      <button type="button" disabled={cover.pending} onClick={cover.fetch} data-testid="refetch-cover">
        go
      </button>
      <span data-testid="version">{detail.data?.coverImageVersion ?? "none"}</span>
      <CoverFetchStatus contentId="c1" />
    </>
  );
}

describe("fetching the cover again", () => {
  it("replaces the detail with the answer and refreshes the lists that show covers", async () => {
    const api = mockApi({
      "GET /api/contents/c1": { body: contentDetail({ coverImageVersion: 1 }) },
      "GET /api/contents": { body: { items: [], total: 0 } },
      [FETCH]: { body: { content: contentDetail({ coverImageVersion: 2 }) } },
    });
    renderApp(<Harness />);
    await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("1"));
    await waitFor(() => expect(api.calls.filter((call) => call.path === "/api/contents")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("refetch-cover"));
    await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("2"));
    expect(api.calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body])).toEqual([["/api/contents/c1/cover/fetch", {}]]);
    await waitFor(() => expect(api.calls.filter((call) => call.path === "/api/contents")).toHaveLength(2));
    expect(await screen.findByText("封面已更新")).toBeTruthy();
    expect(screen.queryByTestId("content-cover-status")).toBeNull();
  });

  it("says why it failed and keeps the old cover", async () => {
    mockApi({
      "GET /api/contents/c1": { body: contentDetail({ coverImageVersion: 1 }) },
      "GET /api/contents": { body: { items: [], total: 0 } },
      [FETCH]: { status: 422, body: { error: { class: "platform_blocked", code: "platform_blocked", retryDisposition: "never", userMessage: "平台限制了访问" } } },
    });
    renderApp(<Harness />);
    await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("1"));
    fireEvent.click(screen.getByTestId("refetch-cover"));
    expect((await screen.findByTestId("content-cover-status")).textContent).toBe("没能重新获取封面：平台限制了访问（原封面保留）");
    expect(screen.getByTestId("version").textContent).toBe("1");
  });
});
