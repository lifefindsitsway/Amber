import { describe, expect, it } from "vitest";
import { UI_LANGUAGE_DEFAULT } from "../../src/shared/defaults.ts";
import { chatStreamEventSchemas } from "../../src/shared/dto/chat.ts";
import { zhCN } from "../../src/shared/i18n/zh-CN/index.ts";
import { initI18n, RESOURCES } from "../../src/web/i18n.ts";

// Every source file of the SPA, as text, so used keys can be checked against the bundle.
const SOURCES = import.meta.glob<string>(["../../src/web/**/*.ts", "../../src/web/**/*.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const NAMESPACES = Object.keys(zhCN);
// Protocol names that happen to start like a namespace (`search.started`), not copy keys.
const NOT_KEYS = new Set<string>(Object.keys(chatStreamEventSchemas));
const KEY_LITERAL = new RegExp(`["'\`]((?:${NAMESPACES.join("|")})\\.[A-Za-z0-9_.]+?)(\\.?\\$\\{|["'\`])`, "g");

function lookup(path: string): unknown {
  let node: unknown = zhCN;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object" || !(part in node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function leaves(node: unknown, prefix: string, out: Array<[string, unknown]>): void {
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      leaves(value, prefix === "" ? key : `${prefix}.${key}`, out);
    }
  } else {
    out.push([prefix, node]);
  }
}

describe("i18n resources", () => {
  it("registers the zh-CN bundle as the default language", () => {
    expect(Object.keys(RESOURCES)).toEqual([UI_LANGUAGE_DEFAULT]);
    const i18n = initI18n();
    expect(i18n.t("common.nav.library")).toBe(zhCN.common.nav.library);
  });

  it("has a non-empty string for every leaf", () => {
    const out: Array<[string, unknown]> = [];
    leaves(zhCN, "", out);
    const bad = out.filter(([, value]) => typeof value !== "string" || value.trim() === "").map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("resolves every key the SPA references", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      for (const match of text.matchAll(KEY_LITERAL)) {
        const key = match[1] as string;
        if (NOT_KEYS.has(key)) continue;
        const dynamic = (match[2] as string).includes("${");
        const value = lookup(key);
        // `t(\`common.stage.${id}\`)` needs an object of strings; a static key needs a string.
        const ok = dynamic ? value !== null && typeof value === "object" : typeof value === "string";
        if (!ok) {
          missing.push(`${file.replace(/^.*src\/web\//, "src/web/")}: ${key}${dynamic ? ".*" : ""}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
