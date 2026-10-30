import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useTaskHub } from "../../../src/web/api/context.tsx";
import { useVersion } from "../../../src/web/api/queries.ts";
import { EVENT_SIDECAR_FAILED, EVENT_SIDECAR_RESTARTED } from "../../../src/web/desktop/bridge.ts";
import { DesktopIntegration, externalHref } from "../../../src/web/desktop/desktop-integration.tsx";
import { UpdateController } from "../../../src/web/desktop/updater.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const tauri = vi.hoisted(() => ({
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  check: vi.fn<() => Promise<unknown>>(),
  setFullscreen: vi.fn<(fullscreen: boolean) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (command: string) => (command === "sidecar_endpoint" ? { endpoint: "http://127.0.0.1:5555", token: "new-token" } : null),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauri.openUrl }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: tauri.check }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFullscreen: tauri.setFullscreen }) }));
vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const OLD = "http://127.0.0.1:4444";
const NEW = "http://127.0.0.1:5555";

/** Holds a query and the task stream open, like any page does. */
function Probe() {
  const version = useVersion();
  const hub = useTaskHub();
  useEffect(() => hub.onEvent(() => undefined), [hub]);
  return <p data-testid="probe">{version.data?.version ?? ""}</p>;
}

function routes() {
  const version = (value: string) => ({ body: { version: value, mode: "local" } });
  return {
    [`GET ${OLD}/api/version`]: version("old"),
    [`GET ${NEW}/api/version`]: version("new"),
    [`GET ${OLD}/api/tasks/events`]: {},
    [`GET ${NEW}/api/tasks/events`]: {},
  };
}

function setup(ui = <Probe />) {
  const api = mockApi(routes());
  const result = renderApp(
    <>
      <DesktopIntegration updateController={new UpdateController()} />
      {ui}
    </>,
    { endpoint: { baseUrl: OLD, token: "old-token" } },
  );
  return { ...api, ...result };
}

beforeEach(() => {
  fakeShell.desktop = true;
  for (const mock of Object.values(tauri)) mock.mockReset();
  tauri.check.mockResolvedValue(null);
  tauri.openUrl.mockResolvedValue(undefined);
  tauri.setFullscreen.mockResolvedValue(undefined);
});

describe("sidecar recovery", () => {
  it("moves to the restarted sidecar's endpoint, reopens the task stream and refetches every query", async () => {
    const { calls } = setup();
    expect((await screen.findByTestId("probe")).textContent).toBe("");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("old"));
    await waitFor(() => expect(fakeShell.listeners.get(EVENT_SIDECAR_RESTARTED)?.size).toBe(1));
    act(() => fakeShell.emit(EVENT_SIDECAR_RESTARTED));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("new"));
    const fresh = calls.filter((call) => call.path.startsWith(NEW));
    expect(fresh.map((call) => call.path)).toEqual(expect.arrayContaining([`${NEW}/api/version`, `${NEW}/api/tasks/events`]));
    expect(fresh.every((call) => call.headers["authorization"] === "Bearer new-token")).toBe(true);
  });

  it("shows a persistent banner once the shell gave up on the sidecar", async () => {
    setup();
    await waitFor(() => expect(fakeShell.listeners.get(EVENT_SIDECAR_FAILED)?.size).toBe(1));
    expect(screen.queryByTestId("sidecar-failed")).toBeNull();
    act(() => fakeShell.emit(EVENT_SIDECAR_FAILED, "sidecar exited"));
    expect((await screen.findByTestId("sidecar-failed")).textContent).toBe("后端已停止，请重启 Amber");
  });

  it("does nothing outside the desktop client", async () => {
    fakeShell.desktop = false;
    setup();
    await screen.findByTestId("probe");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakeShell.listeners.size).toBe(0);
    expect(tauri.check).not.toHaveBeenCalled();
  });
});

describe("external links", () => {
  it("opens http(s) links that leave the app in the system browser and leaves the rest alone", async () => {
    setup(
      <>
        <a href="https://www.youtube.com/watch?v=x" target="_blank" rel="noopener noreferrer">
          external
        </a>
        <a href="mailto:someone@example.com">mail</a>
        <a href="/library">inside</a>
      </>,
    );
    await waitFor(() => expect(tauri.check).toHaveBeenCalled());
    // Runs after the app's document listener: records its verdict, then keeps jsdom from navigating.
    const intercepted: boolean[] = [];
    const after = (event: MouseEvent): void => {
      intercepted.push(event.defaultPrevented);
      event.preventDefault();
    };
    window.addEventListener("click", after);
    onTestFinished(() => window.removeEventListener("click", after));
    fireEvent.click(screen.getByText("external"));
    await waitFor(() => expect(tauri.openUrl).toHaveBeenCalledWith("https://www.youtube.com/watch?v=x"));
    fireEvent.click(screen.getByText("mail"));
    fireEvent.click(screen.getByText("inside"));
    expect(intercepted).toEqual([true, false, false]);
    expect(tauri.openUrl).toHaveBeenCalledTimes(1);
  });

  it("classifies anchors by scheme, target and origin", () => {
    const anchor = (href: string, target = "") => Object.assign(document.createElement("a"), { href, target });
    const origin = "http://tauri.localhost";
    expect(externalHref(anchor("https://example.com/"), origin)).toBe("https://example.com/");
    expect(externalHref(anchor("http://tauri.localhost/library"), origin)).toBeUndefined();
    expect(externalHref(anchor("http://tauri.localhost/library", "_blank"), origin)).toBe("http://tauri.localhost/library");
    expect(externalHref(anchor("javascript:void(0)", "_blank"), origin)).toBeUndefined();
    expect(externalHref(anchor("file:///C:/x.txt", "_blank"), origin)).toBeUndefined();
  });
});

describe("update prompt", () => {
  it("offers a version found by the start-up check without downloading it", async () => {
    const download = vi.fn(async () => undefined);
    tauri.check.mockResolvedValue({ version: "0.2.0", download, install: vi.fn(async () => undefined) });
    setup();
    const prompt = await screen.findByTestId("update-prompt");
    expect(prompt.textContent).toContain("发现新版本");
    expect(screen.getByTestId("update-version").textContent).toBe("v0.2.0");
    expect(download).not.toHaveBeenCalled();
    expect(tauri.check).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the check fails", async () => {
    tauri.check.mockRejectedValue(new Error("offline"));
    setup();
    await waitFor(() => expect(tauri.check).toHaveBeenCalled());
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });
});

describe("native fullscreen", () => {
  function fullscreenAs(element: Element | null): void {
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
    onTestFinished(() => {
      Reflect.deleteProperty(document, "fullscreenElement");
    });
    document.dispatchEvent(new Event("fullscreenchange"));
  }

  it("takes the window into and out of fullscreen with whatever element the page made fullscreen", async () => {
    setup();
    await waitFor(() => expect(tauri.check).toHaveBeenCalled());
    // A platform iframe's own fullscreen button counts as much as the local player.
    fullscreenAs(document.createElement("iframe"));
    await waitFor(() => expect(tauri.setFullscreen).toHaveBeenLastCalledWith(true));
    fullscreenAs(null);
    await waitFor(() => expect(tauri.setFullscreen).toHaveBeenLastCalledWith(false));
    expect(tauri.setFullscreen).toHaveBeenCalledTimes(2);
  });

  it("leaves the window alone outside the desktop client and when the call fails", async () => {
    fakeShell.desktop = false;
    const { unmount } = setup();
    await screen.findByTestId("probe");
    fullscreenAs(document.body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tauri.setFullscreen).not.toHaveBeenCalled();
    unmount();

    fakeShell.desktop = true;
    tauri.setFullscreen.mockRejectedValue(new Error("denied"));
    setup();
    await waitFor(() => expect(tauri.check).toHaveBeenCalled());
    fullscreenAs(document.body);
    await waitFor(() => expect(tauri.setFullscreen).toHaveBeenCalledWith(true));
  });
});
