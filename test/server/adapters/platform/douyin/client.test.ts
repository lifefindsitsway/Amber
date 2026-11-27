import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOUYIN_ORIGIN, DouyinClient, isOnHosts } from "../../../../../src/server/adapters/platform/douyin/client.ts";
import { BROWSER_USER_AGENT } from "../../../../../src/server/adapters/platform/http.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { DOUYIN_BLOCK_COOLDOWN_MS, DOUYIN_VISITOR_TTL_MS, PLATFORM_JSON_MAX_BYTES } from "../../../../../src/shared/defaults.ts";
import { fakeDouyin } from "../../../../fixtures/platform/douyin/fake-platform.ts";
import { signal } from "../../../../fixtures/platform/scripted-io.ts";

const DETAIL = "/aweme/v1/web/aweme/detail/";
const ID = [["aweme_id", "7900000000000000001"]] as const;

function setup() {
  const fake = fakeDouyin();
  let now = 1_800_000_000_000;
  const client = new DouyinClient(fake.http, () => now);
  return { fake, client, advance: (ms: number) => (now += ms) };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("isOnHosts", () => {
  it("admits https URLs on a listed host or below it at a domain boundary only", () => {
    const hosts = ["douyin.com"];
    expect(isOnHosts("https://www.douyin.com/video/1", hosts)).toBe(true);
    expect(isOnHosts("https://douyin.com/", hosts)).toBe(true);
    expect(isOnHosts("https://WWW.DOUYIN.COM/", hosts)).toBe(true);
    for (const url of [
      "http://www.douyin.com/",
      "https://evildouyin.com/",
      "https://douyin.com.evil.example/",
      "https://user:pass@www.douyin.com/",
      "https://www.douyin.com:8443/",
      "ftp://www.douyin.com/",
      "not a url",
    ]) {
      expect(isOnHosts(url, hosts), url).toBe(false);
    }
  });
});

describe("DouyinClient visitor session", () => {
  it("registers a visitor, reads the uifid from the homepage and signs a request with both", async () => {
    const { fake, client } = setup();
    const answer = await client.get(DETAIL, ID, signal());
    expect(answer.status).toBe(200);
    const [register] = fake.registrations();
    expect(register).toMatchObject({ method: "POST", publicOnly: true, redirect: "manual" });
    expect(register?.headers).toMatchObject({ "User-Agent": BROWSER_USER_AGENT, "Content-Type": "application/json" });
    const [home] = fake.homepages();
    expect(home).toMatchObject({ method: "GET", publicOnly: true, redirect: "manual" });
    expect(home?.headers?.["Cookie"]).toMatch(/^ttwid=TESTONLY_ttwid1; passport_csrf_token=[0-9a-f]{32}$/);
    const [request] = fake.api("detail");
    expect(request).toMatchObject({ method: "GET", publicOnly: true, redirect: "manual" });
    expect(request?.url.startsWith(`${DOUYIN_ORIGIN}${DETAIL}?aweme_id=7900000000000000001&aid=6383&uifid=TESTONLYuifid0001&timestamp=1800000000&`)).toBe(true);
    expect(request?.headers).toMatchObject({ Referer: "https://www.douyin.com/" });
    expect(request?.headers?.["Cookie"]).toBe(home?.headers?.["Cookie"]);
  });

  it("serves requests of different users from one session until it expires", async () => {
    const { fake, client, advance } = setup();
    // Requests carry no user: whoever asks, the process-wide session answers.
    await client.get(DETAIL, ID, signal());
    await client.get(DETAIL, [["aweme_id", "7900000000000000002"]], signal());
    expect(fake.registrations()).toHaveLength(1);
    expect(fake.homepages()).toHaveLength(1);
    advance(DOUYIN_VISITOR_TTL_MS - 1);
    await client.get(DETAIL, ID, signal());
    expect(fake.registrations()).toHaveLength(1);
    advance(1);
    await client.get(DETAIL, ID, signal());
    expect(fake.registrations()).toHaveLength(2);
    expect(fake.api("detail").at(-1)?.headers?.["Cookie"]).toMatch(/^ttwid=TESTONLY_ttwid2;/);
  });

  it("shares one session build between concurrent requests", async () => {
    const { fake, client } = setup();
    await Promise.all([client.get(DETAIL, ID, signal()), client.get(DETAIL, ID, signal()), client.get(DETAIL, ID, signal())]);
    expect(fake.registrations()).toHaveLength(1);
    expect(fake.api("detail")).toHaveLength(3);
  });

  it("rebuilds the session once when the signature is refused and sends the request again", async () => {
    const { fake, client } = setup();
    await client.get(DETAIL, ID, signal());
    fake.revoked.add("TESTONLYuifid0001");
    const answer = await client.get(DETAIL, ID, signal());
    expect(answer.status).toBe(200);
    expect(fake.registrations()).toHaveLength(2);
    expect(fake.api("detail")).toHaveLength(3);
  });

  it("refused again after the rebuild: access_changed, then no request at all for the cooldown", async () => {
    const { fake, client, advance } = setup();
    fake.refuseAll = true;
    expect(await codeOf(client.get(DETAIL, ID, signal()))).toBe("platform_blocked.access_changed");
    expect(fake.api("detail")).toHaveLength(2);
    expect(fake.registrations()).toHaveLength(2);

    const before = fake.http.requests.length;
    advance(DOUYIN_BLOCK_COOLDOWN_MS - 1);
    expect(await codeOf(client.get(DETAIL, ID, signal()))).toBe("platform_blocked.access_changed");
    expect(fake.http.requests).toHaveLength(before);

    fake.refuseAll = false;
    advance(1);
    expect((await client.get(DETAIL, ID, signal())).status).toBe(200);
    expect(fake.http.requests.length).toBeGreaterThan(before);
  });

  it("returns a 403 that is not a signature refusal as an answer, without rebuilding", async () => {
    const { fake, client } = setup();
    fake.detail = () => ({ status: 403, body: "Forbidden" });
    expect((await client.get(DETAIL, ID, signal())).status).toBe(403);
    expect(fake.registrations()).toHaveLength(1);
  });

  it("reads API answers within the JSON cap", async () => {
    const { fake, client } = setup();
    fake.detail = () => ({ body: "x".repeat(PLATFORM_JSON_MAX_BYTES + 1) });
    expect(await codeOf(client.get(DETAIL, ID, signal()))).toBe("source_html_error_page");
  });

  it("maps a refused or broken visitor registration to source errors", async () => {
    for (const [answer, code] of [
      [{ status: 429 }, "platform_blocked.visitor_refused"],
      [{ status: 412 }, "platform_blocked.visitor_refused"],
      [{ status: 500 }, "source_unreachable"],
      [{ status: 200, body: {} }, "source_unreachable"],
    ] as const) {
      const { fake, client } = setup();
      fake.register = () => answer;
      expect(await codeOf(client.get(DETAIL, ID, signal())), JSON.stringify(answer)).toBe(code);
      expect(fake.api("detail")).toHaveLength(0);
    }
  });

  it("fails without a usable uifid from the homepage", async () => {
    const { fake, client } = setup();
    fake.home = () => ({ body: "<html></html>" });
    expect(await codeOf(client.get(DETAIL, ID, signal()))).toBe("source_unreachable");
    fake.home = () => ({ body: "", headers: { "x-tt-trace-host": "bad value;with=chars" } });
    expect(await codeOf(client.get(DETAIL, ID, signal()))).toBe("source_unreachable");
    expect(fake.api("detail")).toHaveLength(0);
  });

  it("takes the uifid from a homepage cookie when there is one", async () => {
    const { fake, client } = setup();
    fake.home = () => ({ body: "", setCookies: ["UIFID_TEMP=TESTONLYcookieuifid; Path=/"] });
    // The fake honours only the uifids it hands out in the trace header, so this one is refused.
    expect(await codeOf(client.get(DETAIL, ID, signal()))).toBe("platform_blocked.access_changed");
    expect(fake.api("detail")[0]?.url).toContain("uifid=TESTONLYcookieuifid&");
  });

  it("keeps the session in memory only: no file access and nothing of it in errors", async () => {
    const source = readFileSync(new URL("../../../../../src/server/adapters/platform/douyin/client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:fs|from "fs|console\.|logger/);
    const { fake, client } = setup();
    fake.refuseAll = true;
    let caught: unknown;
    try {
      await client.get(DETAIL, ID, signal());
    } catch (error) {
      caught = error;
    }
    expect(isAmberError(caught)).toBe(true);
    const text = JSON.stringify({ message: (caught as Error).message, appError: isAmberError(caught) ? caught.appError : undefined });
    for (const value of fake.handedOut) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toMatch(/x-secsdk-web-signature|uifid|passport_csrf_token|ttwid/i);
  });
});
