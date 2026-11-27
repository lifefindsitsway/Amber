import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { DESIGN_DOC_ALLOWLIST, type DesignDocAllowlistEntry } from "./design-doc-allowlist.ts";
import type { Violation } from "./files.ts";
import { committableFiles } from "./secret-scan.ts";

/**
 * The design-document reference guard. The internal design documents and the root agent
 * instructions are not published with the source, so nothing that is published may point
 * at them: no document names, no section, appendix, decision, acceptance or stage numbers,
 * no invariant stars or circled guard numbers. Rules and their reasons belong in the code
 * comments themselves.
 *
 * Every banned word below is assembled at runtime so that this file does not match itself.
 */

interface Rule {
  id: string;
  pattern: RegExp;
  /** Removes text the rule must not look at; replaced by spaces so columns stay put. */
  strip?: RegExp;
}

const concat = (...parts: string[]): string => parts.join("");

const PLAN = concat("Pl", "an");
const STAGE = concat("V", "1");
// The later stage document is banned by file name only: its bare token is an ordinary identifier.
const STAGE_FILES = [STAGE, concat("V", "2")];
const AGENT_RULES = concat("CLA", "UDE");
const DOC_NAMES = [PLAN, ...STAGE_FILES, AGENT_RULES, concat("vers", "ion"), concat("todo", "list"), concat("analysis", "-result")];
const STAR = String.fromCodePoint(0x2605);
const CIRCLED_FIRST = String.fromCodePoint(0x2460);
const CIRCLED_LAST = String.fromCodePoint(0x2473);
const APPENDIX_CN = concat("附", "录");

const RULES: readonly Rule[] = [
  {
    id: "design-doc-file",
    // Suffixed names are matched without `\b`: an underscore is a word character, so the
    // plain alternatives above never see them.
    pattern: new RegExp(`\\b(?:${DOC_NAMES.join("|")})\\.md\\b|${concat("checklist_", `(?:${STAGE_FILES.join("|")})`)}|${AGENT_RULES}_${STAGE}`, "gu"),
  },
  {
    id: "docs-path",
    pattern: new RegExp(`(?<![A-Za-z0-9/.:-])${concat("do", "cs/")}`, "gu"),
    // URLs and bare host paths (`example.io/docs/…`) point at public documentation.
    strip: /https?:\/\/\S+|\b[\w.-]+\.(?:com|io|org|dev|net)\/\S*/gu,
  },
  { id: "bare-plan", pattern: new RegExp(`\\b${PLAN}\\b(?!\\.md)`, "gu") },
  {
    id: "section-ref",
    pattern: new RegExp(
      [
        `\\b(?:${PLAN}|${STAGE})\\s*§`,
        `[Cc]hapter \\d`,
        `[Aa]ppendix[- ]?\\d`,
        `${APPENDIX_CN}[一二三四五]`,
        `\\bA[1-5]\\.\\d{1,2}\\b`,
        `\\b[Pp]rinciple \\d`,
      ].join("|"),
      "gu",
    ),
  },
  { id: "frozen-contract", pattern: new RegExp(`${STAR}|${concat("frozen", " contract")}`, "giu") },
  { id: "decision-ref", pattern: /\bD\d{2,3}\b/gu },
  { id: "acceptance-id", pattern: /\b[A-Z]-\d{1,2}\b/gu },
  { id: "circled-number", pattern: new RegExp(`[${CIRCLED_FIRST}-${CIRCLED_LAST}]`, "gu") },
  { id: "stage-ref", pattern: new RegExp(`\\b${STAGE}-[A-Z]\\b|\\b${STAGE}\\b`, "gu") },
  { id: "claude-rule", pattern: new RegExp(`${AGENT_RULES}\\.md S\\d`, "gu") },
];

/** Rule ids in reporting order. */
export const DESIGN_DOC_RULE_IDS: readonly string[] = RULES.map((rule) => rule.id);

/** Extensions that are binary by construction; any other file holding a NUL byte is binary too. */
const BINARY_EXTENSIONS = new Set(["png", "ico", "mp4", "jpg", "jpeg", "gif", "webp", "woff", "woff2", "ttf", "otf", "zip"]);

export interface DesignDocScan {
  violations: Violation[];
  /** Binary files that were not scanned. */
  skipped: string[];
}

interface Hit {
  file: string;
  rule: string;
  line?: number;
  text: string;
}

function hitsIn(file: string, text: string, line: number | undefined): Hit[] {
  const hits: Hit[] = [];
  for (const rule of RULES) {
    const subject = rule.strip === undefined ? text : text.replace(rule.strip, (match) => " ".repeat(match.length));
    for (const match of subject.matchAll(rule.pattern)) {
      hits.push({ file, rule: rule.id, ...(line === undefined ? {} : { line }), text: match[0] });
    }
  }
  return hits;
}

/**
 * Scans `files` (relative to `root`) and their paths. Findings carry file, line and rule
 * only, never the matched text. A file that cannot be read fails the scan instead of being
 * skipped; binary files are skipped and listed.
 */
export function scanDesignDocReferences(
  root: string,
  files: readonly string[],
  allowlist: readonly DesignDocAllowlistEntry[] = DESIGN_DOC_ALLOWLIST,
): DesignDocScan {
  const hits: Hit[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    hits.push(...hitsIn(file, file, undefined));
    if (BINARY_EXTENSIONS.has(extname(file).slice(1).toLowerCase())) {
      skipped.push(file);
      continue;
    }
    let content: Buffer;
    try {
      content = readFileSync(join(root, file));
    } catch (error) {
      throw new Error(`design-doc reference scan cannot read ${file}`, { cause: error });
    }
    if (content.includes(0)) {
      skipped.push(file);
      continue;
    }
    content
      .toString("utf8")
      .split(/\r?\n/u)
      .forEach((text, index) => hits.push(...hitsIn(file, text, index + 1)));
  }

  const used = new Set<DesignDocAllowlistEntry>();
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const entry = allowlist.find((candidate) => candidate.file === hit.file && candidate.pattern === hit.text);
    if (entry !== undefined) {
      used.add(entry);
      continue;
    }
    const key = `${hit.file}\0${hit.line ?? 0}\0${hit.rule}`;
    if (!seen.has(key)) {
      seen.add(key);
      violations.push({ file: hit.file, rule: hit.rule, ...(hit.line === undefined ? {} : { line: hit.line }) });
    }
  }
  const scanned = new Set(files);
  for (const entry of allowlist) {
    if (!used.has(entry) && scanned.has(entry.file)) {
      violations.push({ file: entry.file, rule: "allowlist-unused" });
    }
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
  return { violations, skipped: skipped.sort() };
}

/**
 * The published file set: every committable file except the internal documents themselves
 * (the documentation directory and the root agent instructions). A tracked file deleted in
 * the working tree is not content any more and is left out; every other listed file must be
 * readable.
 */
export function designDocScanFiles(root: string): string[] {
  const deleted = new Set(
    execFileSync("git", ["ls-files", "-d", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((file) => file.length > 0),
  );
  const docsDir = concat("do", "cs/");
  const agentRules = `${AGENT_RULES}.md`;
  return committableFiles(root).filter((file) => !deleted.has(file) && !file.startsWith(docsDir) && file !== agentRules);
}
