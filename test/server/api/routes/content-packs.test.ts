import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleBuild, writeSamplePack } from "../../../fixtures/content-pack/pack.ts";
import { composeServerStack, STACK_ORIGIN, type ComposedStack } from "../../../fixtures/server/composed-stack.ts";

/**
 * The upload route over a real connection: `inject` never closes a request the way a socket
 * does, and a request's `close` comes as soon as its body was read, which must not cancel
 * the upload that just reached its end.
 */

let stack: ComposedStack;
let cookie: string;
let port: number;
let pack: Buffer;

beforeAll(async () => {
  stack = await composeServerStack();
  // Content pack jobs wait for the start-up recovery, as the real server's do.
  await stack.composition.startBackground();
  cookie = (await stack.createUser("packer")).cookie;
  await stack.composition.app.listen({ host: "127.0.0.1", port: 0 });
  port = (stack.composition.app.server.address() as AddressInfo).port;
  const dir = join(stack.dataDir, "..", `pack-src-${port}`);
  mkdirSync(dir, { recursive: true });
  const { build } = sampleBuild(dir, { count: 2, mediaBytes: 3 * 1024 * 1024 });
  const target = join(dir, "in.amberpack");
  await writeSamplePack(target, build);
  pack = readFileSync(target);
}, 60_000);

afterAll(async () => {
  await stack?.close();
});

const headers = (): Record<string, string> => ({
  "x-amber-request": "1",
  origin: STACK_ORIGIN,
  cookie,
  "content-type": "application/octet-stream",
  "x-amber-filename": encodeURIComponent("我的包.amberpack"),
});

/** Sends `body` in slices with pauses, so the server reads it as a stream; `stopAfter` hangs up early. */
function upload(body: Buffer, stopAfter?: number): Promise<{ status: number; json: unknown } | "closed"> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/content-packs/imports/upload", headers: headers() }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (chunk: Buffer) => parts.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(parts).toString() || "null") }));
    });
    request.on("error", (error) => (stopAfter === undefined ? reject(error) : resolve("closed")));
    const slice = 256 * 1024;
    let at = 0;
    const next = (): void => {
      if (stopAfter !== undefined && at >= stopAfter) {
        request.destroy();
        resolve("closed");
        return;
      }
      if (at >= body.length) {
        request.end();
        return;
      }
      request.write(body.subarray(at, at + slice));
      at += slice;
      setTimeout(next, 5);
    };
    next();
  });
}

describe("content pack upload over a real connection", () => {
  it("receives the whole streamed body and goes on to the preview, not cancelled", async () => {
    const answer = await upload(pack);
    expect(answer).not.toBe("closed");
    const { status, json } = answer as { status: number; json: { jobId: string } };
    expect(status).toBe(202);
    const job = async () => (await stack.send({ method: "GET", url: `/api/content-packs/imports/${json.jobId}` }, cookie)).json() as { status: string; bytesTotal: number; fileName?: string };
    let current = await job();
    const deadline = Date.now() + 10_000;
    while ((current.status === "previewing" || current.status === "receiving") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      current = await job();
    }
    expect(current.status).not.toBe("cancelled");
    expect(current.bytesTotal).toBe(pack.length);
    expect(current.fileName).toBe("我的包.amberpack");
    await stack.send({ method: "DELETE", url: `/api/content-packs/imports/${json.jobId}` }, cookie);
  }, 30_000);

  it("a client that hangs up mid-upload leaves no staging and no running job", async () => {
    expect(await upload(pack, 1024 * 1024)).toBe("closed");
    const importsDir = join(stack.dataDir, "tmp", "content-packs", "imports");
    const active = async () => (await stack.send({ method: "GET", url: "/api/content-packs/active" }, cookie)).json() as { importJobId?: string };
    const deadline = Date.now() + 10_000;
    let state = await active();
    while ((state.importJobId !== undefined || readdirSync(importsDir).length > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await active();
    }
    expect(state.importJobId).toBeUndefined();
    expect(readdirSync(importsDir)).toEqual([]);
  }, 30_000);
  it("answers conflict.starting_up until the start-up recovery has finished", async () => {
    const fresh = await composeServerStack();
    try {
      const user = await fresh.createUser("early");
      const upload = await fresh.composition.app.inject({
        method: "POST",
        url: "/api/content-packs/imports/upload",
        headers: { "x-amber-request": "1", origin: STACK_ORIGIN, cookie: user.cookie, "content-type": "application/octet-stream" },
        payload: pack,
      });
      expect([upload.statusCode, (upload.json() as { error: { code: string } }).error.code]).toEqual([409, "conflict.starting_up"]);
      await fresh.composition.startBackground();
      const after = await fresh.composition.app.inject({
        method: "POST",
        url: "/api/content-packs/imports/upload",
        headers: { "x-amber-request": "1", origin: STACK_ORIGIN, cookie: user.cookie, "content-type": "application/octet-stream" },
        payload: pack,
      });
      expect(after.statusCode).toBe(202);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
