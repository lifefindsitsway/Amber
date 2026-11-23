import ts from "typescript";
import { isUnder, lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";
import { WEB_NATIVE_CONTROLS_ALLOWLIST, type WebNativeControlsAllowlistEntry } from "./web-native-controls-allowlist.ts";

/**
 * What the shared controls and notices in `src/web/ui` replace:
 * - `native-select`: a JSX `<select>`; use `NativeSelect` (or the menu-style `Select`), which carry
 *   the shared border, height scale, focus ring, invalid state and the theme's chevron.
 * - `native-checkbox` / `native-radio`: a JSX `<input>` whose `type` is the literal "checkbox" /
 *   "radio"; use `Checkbox`, `Radio` or `RadioCard` (size, accent colour, focus ring, label wiring).
 * - `hand-tinted-notice`: a class string carrying one of `HAND_TINTED_NOTICE_CLASSES`; use
 *   `Callout`, `Banner`, `InlineNote` or `FieldError`, which draw notices in the tone colours.
 */
export type WebNativeControlRule = "native-select" | "native-checkbox" | "native-radio" | "hand-tinted-notice";

export const WEB_NATIVE_CONTROL_RULES: readonly WebNativeControlRule[] = ["native-select", "native-checkbox", "native-radio", "hand-tinted-notice"];

/**
 * Classes that, in this code base, only ever build a hand-made notice box: a faint danger or accent
 * border, or a faint danger / accent wash. Kept deliberately narrow so that nothing else is caught:
 * - `border-danger/40`, `bg-danger/5`: the hand-made error box (the tone is now `Callout` "error").
 * - `border-accent/40`, `bg-accent/5`: the hand-made caution box tinted with the brand accent; the
 *   accent marks actions and selection, cautions take the `warn` tone.
 * Left out on purpose: `bg-danger/10` and `bg-ok/10` (status badges and chips, not notices),
 * `bg-accent-soft` alone (selected rows and pressed toggles), and the Tailwind palette hues
 * (`amber-`, `yellow-`, `green-`, `emerald-`: highlight marks and user-chosen note colours).
 */
export const HAND_TINTED_NOTICE_CLASSES: ReadonlySet<string> = new Set(["border-danger/40", "bg-danger/5", "border-accent/40", "bg-accent/5"]);

/** The shared controls themselves are written with the native elements. */
const EXEMPT_DIR = "src/web/ui";

export type WebNativeControlCounts = Partial<Record<WebNativeControlRule, number>>;

interface Occurrence {
  rule: WebNativeControlRule;
  line: number;
}

function stringValue(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxExpression(node)) return stringValue(node.expression);
  if (ts.isParenthesizedExpression(node)) return stringValue(node.expression);
  return undefined;
}

function tagName(node: ts.Node): { name: string; attributes: ts.JsxAttributes } | undefined {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    return { name: node.tagName.getText(), attributes: node.attributes };
  }
  return undefined;
}

function literalTexts(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return undefined;
}

function occurrences(source: ts.SourceFile): Occurrence[] {
  const found: Occurrence[] = [];
  visit(source, (node) => {
    const tag = tagName(node);
    if (tag !== undefined) {
      if (tag.name === "select") {
        found.push({ rule: "native-select", line: lineOf(source, node) });
      } else if (tag.name === "input") {
        const type = tag.attributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === "type");
        const value = stringValue(type?.initializer);
        if (value === "checkbox") found.push({ rule: "native-checkbox", line: lineOf(source, node) });
        if (value === "radio") found.push({ rule: "native-radio", line: lineOf(source, node) });
      }
      return;
    }
    const text = literalTexts(node);
    if (text !== undefined && text.split(/\s+/).some((token) => HAND_TINTED_NOTICE_CLASSES.has(token))) {
      found.push({ rule: "hand-tinted-notice", line: lineOf(source, node) });
    }
  });
  return found;
}

/** Per file of `src/web` (outside `src/web/ui`), how many of each pattern it holds; files with none are left out. */
export function webNativeControlCounts(root: string): Map<string, { counts: WebNativeControlCounts; occurrences: Occurrence[] }> {
  const result = new Map<string, { counts: WebNativeControlCounts; occurrences: Occurrence[] }>();
  for (const file of listFiles(root, ["src/web"], TS_EXTENSIONS)) {
    if (isUnder(file, EXEMPT_DIR)) continue;
    const found = occurrences(parseSource(root, file));
    if (found.length === 0) continue;
    const counts: WebNativeControlCounts = {};
    for (const { rule } of found) counts[rule] = (counts[rule] ?? 0) + 1;
    result.set(file, { counts, occurrences: found });
  }
  return result;
}

/**
 * Native controls and hand-tinted notices in `src/web` outside `src/web/ui`. Files still waiting
 * for migration are allowlisted with their counts: a file may not exceed its counts (new code uses
 * the shared components), and an entry must match the file exactly (a migrated file lowers or
 * removes its entry), so the remaining work is always the allowlist itself.
 */
export function webNativeControls(root: string, allowlist: readonly WebNativeControlsAllowlistEntry[] = WEB_NATIVE_CONTROLS_ALLOWLIST): Violation[] {
  const violations: Violation[] = [];
  const actual = webNativeControlCounts(root);
  const entries = new Map(allowlist.map((entry) => [entry.file, entry]));
  for (const [file, { counts, occurrences: found }] of actual) {
    const entry = entries.get(file);
    if (entry === undefined) {
      for (const { rule, line } of found) violations.push({ file, rule, line });
      continue;
    }
    for (const rule of WEB_NATIVE_CONTROL_RULES) {
      const have = counts[rule] ?? 0;
      const allowed = entry.counts[rule] ?? 0;
      if (have > allowed) violations.push({ file, rule: `${rule}-over-allowlist` });
      if (have < allowed) violations.push({ file, rule: `${rule}-allowlist-stale` });
    }
  }
  for (const entry of allowlist) {
    if (!actual.has(entry.file)) violations.push({ file: entry.file, rule: "allowlist-unused" });
  }
  return violations;
}
