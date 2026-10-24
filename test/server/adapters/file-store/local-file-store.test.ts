import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import { FileTooLargeError } from "../../../../src/server/ports/file-store.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const digestOf = (data: Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield Buffer.from(part);
  }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString();
}

describe("LocalFileStore", () => {
  it("writes atomically and reports size and digest", async () => {
    const root = tempDataDir("amber-files-");
    const store = new LocalFileStore(root);
    const stored = await store.writeAtomic("assets/u/c/a", chunks("hello ", "world"));
    expect(stored).toEqual({ sizeBytes: 11, digest: digestOf(Buffer.from("hello world")) });
    expect(readFileSync(join(root, "assets", "u", "c", "a"), "utf8")).toBe("hello world");
    expect(existsSync(join(root, "assets", "u", "c", "a.partial"))).toBe(false);
    expect(await store.digest("assets/u/c/a")).toBe(stored.digest);
    expect(await store.stat("assets/u/c/a")).toEqual({ sizeBytes: 11 });
  });

  it("accepts a producer that writes the partial file itself", async () => {
    const store = new LocalFileStore(tempDataDir("amber-files-"));
    const stored = await store.writeAtomic("tmp/tasks/t/out", async (partial) => writeFile(partial, "produced"));
    expect(stored.sizeBytes).toBe(8);
    expect(await collect(store.read("tmp/tasks/t/out"))).toBe("produced");
  });

  it("stops at maxBytes and leaves nothing behind", async () => {
    const root = tempDataDir("amber-files-");
    const store = new LocalFileStore(root);
    await expect(store.writeAtomic("assets/u/c/a", chunks("12345", "67890"), { maxBytes: 8 })).rejects.toBeInstanceOf(FileTooLargeError);
    expect(await store.list("assets")).toEqual([]);
  });

  it("removes the partial file when beforeCommit rejects", async () => {
    const root = tempDataDir("amber-files-");
    const store = new LocalFileStore(root);
    let seen: string | undefined;
    await expect(
      store.writeAtomic("assets/u/c/a", chunks("data"), {
        beforeCommit: async (partial, stored) => {
          seen = readFileSync(partial, "utf8");
          expect(stored.sizeBytes).toBe(4);
          throw new Error("rejected by sniffing");
        },
      }),
    ).rejects.toThrow("rejected by sniffing");
    expect(seen).toBe("data");
    expect(await store.list("assets")).toEqual([]);
  });

  it("reads inclusive byte ranges", async () => {
    const store = new LocalFileStore(tempDataDir("amber-files-"));
    await store.writeAtomic("assets/u/c/a", Buffer.from("0123456789"));
    expect(await collect(store.read("assets/u/c/a", { start: 2, end: 4 }))).toBe("234");
    expect(await collect(store.read("assets/u/c/a", { start: 7 }))).toBe("789");
  });

  it("rejects refs that escape the data directory", () => {
    const store = new LocalFileStore(tempDataDir("amber-files-"));
    for (const ref of ["../x", "assets/../../x", "/etc/passwd", "assets//x", "C:\\x", "assets/./x", ""]) {
      expect(() => store.pathOf(ref), ref).toThrow(TypeError);
    }
  });

  it("sums committed bytes under a prefix, leaving partial files out", async () => {
    const root = tempDataDir("amber-files-");
    const store = new LocalFileStore(root);
    await store.writeAtomic("assets/u/c1/a", Buffer.from("12345"));
    await store.writeAtomic("assets/u/c2/b", Buffer.from("123"));
    await store.writeAtomic("assets/v/c3/c", Buffer.from("1234567"));
    writeFileSync(join(root, "assets", "u", "c1", "d.partial"), "in flight");
    expect(await store.usedBytes("assets/u")).toBe(8);
    expect(await store.usedBytes("assets/v")).toBe(7);
    expect(await store.usedBytes("assets/nobody")).toBe(0);
  });

  it("lists, removes trees and sweeps partial files", async () => {
    const root = tempDataDir("amber-files-");
    const store = new LocalFileStore(root);
    await store.writeAtomic("tmp/tasks/t1/a.json", Buffer.from("{}"));
    await store.writeAtomic("tmp/tasks/t1/nested/b", Buffer.from("b"));
    mkdirSync(join(root, "assets", "u", "c"), { recursive: true });
    writeFileSync(join(root, "assets", "u", "c", "x.partial"), "debris");
    // The default cache directory is the flat cache store's to sweep, by its own rules.
    mkdirSync(join(root, "media"));
    writeFileSync(join(root, "media", "mine.partial"), "the user's");
    expect(await store.list("tmp/tasks")).toEqual(["tmp/tasks/t1/a.json", "tmp/tasks/t1/nested/b"]);
    expect(await store.list("tmp/missing")).toEqual([]);
    expect(await store.removePartials()).toBe(1);
    expect(existsSync(join(root, "media", "mine.partial"))).toBe(true);
    await store.remove("tmp/tasks/t1");
    await store.remove("tmp/tasks/t1");
    expect(await store.list("tmp")).toEqual([]);
    expect(await store.stat("tmp/tasks/t1/a.json")).toBeNull();
    expect(await store.digest("tmp/tasks/t1/a.json")).toBeNull();
  });

  it("removes empty directories deepest first and never a file or a directory holding one", async () => {
    const root = tempDataDir("amber-files-");
    const store = new LocalFileStore(root);
    await store.writeAtomic("assets/u/kept/a", Buffer.from("a"));
    mkdirSync(join(root, "assets", "u", "gone", "nested"), { recursive: true });
    mkdirSync(join(root, "assets", "v"), { recursive: true });
    expect(await store.removeEmptyDirs("assets")).toBe(3);
    expect(existsSync(join(root, "assets", "u", "gone"))).toBe(false);
    expect(existsSync(join(root, "assets", "v"))).toBe(false);
    expect(await store.list("assets")).toEqual(["assets/u/kept/a"]);
    expect(await store.removeEmptyDirs("assets/missing")).toBe(0);
    await store.remove("assets/u/kept/a");
    expect(await store.removeEmptyDirs("assets/u/kept")).toBe(1);
    expect(existsSync(join(root, "assets", "u"))).toBe(true);
  });

  it("leaves an empty directory changed at or after olderThan", async () => {
    const root = tempDataDir("amber-files-");
    const store = new LocalFileStore(root);
    mkdirSync(join(root, "assets", "u", "old"), { recursive: true });
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(root, "assets", "u", "old"), past, past);
    const startedAt = Date.now() - 1000;
    mkdirSync(join(root, "assets", "u", "fresh"), { recursive: true });
    expect(await store.removeEmptyDirs("assets", { olderThan: startedAt })).toBe(1);
    expect(existsSync(join(root, "assets", "u", "old"))).toBe(false);
    expect(existsSync(join(root, "assets", "u", "fresh"))).toBe(true);
  });

  it("leaves the cache directory out of the data directory's usage, wherever it is at the time", async () => {
    const root = tempDataDir("amber-files-");
    let cacheDir = join(root, "media");
    const store = new LocalFileStore(root, { usageExclude: () => [cacheDir] });
    await store.writeAtomic("assets/u/a.bin", Buffer.alloc(10));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "第一讲.mp4"), Buffer.alloc(1000));
    expect((await store.diskUsage()).usedBytes).toBe(10);
    cacheDir = join(tempDataDir("amber-files-cache-"), "media");
    expect((await store.diskUsage()).usedBytes).toBe(1010);
  });
});
