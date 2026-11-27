import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { materializeTemplates } from "./lib/fixture.ts";
import { fixtureSanitizationScan, recordedFixtureFiles } from "./lib/fixture-sanitization.ts";

describe("recorded-fixture sanitization", () => {
  it("finds no public address or live signed-URL parameter in committable recorded fixtures", () => {
    const files = recordedFixtureFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(fixtureSanitizationScan(REPO_ROOT, files)).toEqual([]);
  });

  it("rejects every counter-example and accepts placeholders, non-public ranges and version numbers", () => {
    const { root, files } = materializeTemplates("fixture-sanitization");
    expect(files).toEqual(["allowed.json", "ip-plain.json", "ip-url-encoded.txt", "path-signed-no-ip.txt", "path-signed.txt", "query-signed-media.txt", "query-signed-platform.txt", "query-signed-storage.txt"]);
    expect(fixtureSanitizationScan(root, files)).toEqual([
      { file: "ip-plain.json", rule: "public-ipv4" },
      { file: "ip-url-encoded.txt", rule: "public-ipv4" },
      { file: "path-signed-no-ip.txt", rule: "signed-url-param" },
      { file: "path-signed.txt", rule: "public-ipv4" },
      { file: "path-signed.txt", rule: "signed-url-param" },
      { file: "query-signed-media.txt", rule: "signed-url-param" },
      { file: "query-signed-platform.txt", rule: "signed-url-param" },
      { file: "query-signed-storage.txt", rule: "signed-url-param" },
    ]);
  });
});
