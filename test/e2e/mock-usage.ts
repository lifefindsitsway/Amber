import type { Page, Route } from "@playwright/test";
import type { Theme } from "../../src/shared/dto/settings.ts";
import { usageReply } from "../fixtures/usage/handler.ts";
import { SCENARIOS, type ScenarioId } from "../fixtures/usage/scenarios.ts";

/**
 * Answers the usage analysis endpoints from a fixture scenario. Registered after the main
 * backend fake, so it sees `/api/usage/*` first; everything else falls through to it.
 */
export async function installUsageMock(page: Page, scenarioId: ScenarioId): Promise<{ requests: string[] }> {
  const scenario = SCENARIOS[scenarioId]();
  const requests: string[] = [];
  await page.route("**/api/usage/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = usageReply(scenario, `${url.pathname}${url.search}`);
    if (reply === undefined) return route.fallback();
    requests.push(`${url.pathname}${url.search}`);
    if (scenario.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
    return route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) }).catch(() => undefined);
  });
  return { requests };
}

/** Stores the theme through the settings the fake backend keeps; the next page load applies it. */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.goto("/library");
  await page.evaluate(async (next) => {
    await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: next }) });
  }, theme);
}

/** The sidebar's own storage key, so the app starts with the column at this width. */
export async function setSidebarWidth(page: Page, width: number): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("amber.sidebar.width", String(value));
  }, width);
}
