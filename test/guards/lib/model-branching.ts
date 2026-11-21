import ts from "typescript";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isUnder, lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";
import { collectImports } from "./imports.ts";
import { MODEL_BRANCHING_ALLOWLIST, type ModelBranchingAllowlistEntry } from "./model-branching-allowlist.ts";

/** Prefixes of model identifiers across vendors; a literal starting with one names a model. */
const MODEL_ID_LITERAL =
  /^(gpt|chatgpt|o[1-9]|claude|gemini|gemma|deepseek|qwen|qwq|llama|mistral|mixtral|codestral|glm|chatglm|kimi|moonshot|yi-|doubao|ernie|hunyuan|grok|phi-|command-|scribe)/i;

/** Identifiers that hold a model name; comparing them to any literal is branching on the model. */
const MODEL_NAME_IDENTIFIER = /^(model|modelId|modelName|modelDisplay\w*)$/;

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const STRING_MATCHERS = new Set(["startsWith", "endsWith", "includes", "match", "test", "search", "indexOf"]);

/**
 * Model-name branching guard: capability decisions come from `ModelCapability` effective
 * values only, never from the model name. Flags equality and `switch` against model-id
 * literals, string matching with model-id patterns, and any literal comparison of a
 * `model` / `modelId` value. Outside `src/shared` (the preset and copy catalogues) any model-id
 * literal is flagged too, so a lookup table cannot stand in for a comparison.
 *
 * An allowlisted file is not reported, but it must exist, still hold a match, import types only
 * and be imported by its one named importer; each breach is its own violation.
 */
export function modelNameBranching(root: string, allowlist: readonly ModelBranchingAllowlistEntry[] = MODEL_BRANCHING_ALLOWLIST): Violation[] {
  const found: Violation[] = [];
  const files = listFiles(root, ["src"], TS_EXTENSIONS);
  for (const file of files) {
    const source = parseSource(root, file);
    visit(source, (node) => {
      if (ts.isStringLiteralLike(node) && !isUnder(file, "src/shared") && !isModuleSpecifier(node) && MODEL_ID_LITERAL.test(node.text)) {
        found.push({ file, rule: "model-name-literal", line: lineOf(source, node) });
      }
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        const literal = stringLiteral(node.left) ?? stringLiteral(node.right);
        const other = stringLiteral(node.left) !== undefined ? node.right : node.left;
        if (literal !== undefined && (MODEL_ID_LITERAL.test(literal) || namesModel(other))) {
          found.push({ file, rule: "model-name-comparison", line: lineOf(source, node) });
        }
      } else if (ts.isCaseClause(node)) {
        const literal = stringLiteral(node.expression);
        const switched = ts.isSwitchStatement(node.parent.parent) ? node.parent.parent.expression : undefined;
        if (literal !== undefined && (MODEL_ID_LITERAL.test(literal) || (switched && namesModel(switched)))) {
          found.push({ file, rule: "model-name-switch", line: lineOf(source, node) });
        }
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (!STRING_MATCHERS.has(node.expression.name.text)) {
          return;
        }
        const receiver = node.expression.expression;
        const patterns = [receiver, ...node.arguments].map(patternText).filter((text) => text !== undefined);
        const matchesModelPattern = patterns.some((text) => MODEL_ID_LITERAL.test(text.replace(/^\^/, "")));
        const matchesModelValue = namesModel(receiver) || node.arguments.some(namesModel);
        if (matchesModelPattern || (matchesModelValue && patterns.length > 0)) {
          found.push({ file, rule: "model-name-match", line: lineOf(source, node) });
        }
      }
    });
  }
  const allowed = new Set(allowlist.map((entry) => entry.file));
  const violations = found.filter((violation) => !allowed.has(violation.file));
  for (const entry of allowlist) {
    if (!existsSync(join(root, entry.file)) || !found.some((violation) => violation.file === entry.file)) {
      violations.push({ file: entry.file, rule: "allowlist-unused" });
      continue;
    }
    const source = parseSource(root, entry.file);
    visit(source, (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) && !isTypeOnly(node)) {
        violations.push({ file: entry.file, rule: "allowlist-runtime-import", line: lineOf(source, node) });
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        violations.push({ file: entry.file, rule: "allowlist-runtime-import", line: lineOf(source, node) });
      }
    });
    for (const file of files) {
      if (file === entry.file || file === entry.importer) {
        continue;
      }
      const source = parseSource(root, file);
      for (const ref of collectImports(source, file)) {
        if (ref.target === entry.file) {
          violations.push({ file, rule: "allowlist-importer", line: ref.line });
        }
      }
    }
  }
  return violations;
}

/** An import or re-export that brings in types only: `import type`, or every named binding marked `type`. */
function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration): boolean {
  if (ts.isImportEqualsDeclaration(node)) {
    return node.isTypeOnly;
  }
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly || (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((element) => element.isTypeOnly));
  }
  const clause = node.importClause;
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  const bindings = clause.namedBindings;
  return clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node;
}

function stringLiteral(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function patternText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return node.text.slice(1, node.text.lastIndexOf("/"));
  }
  return undefined;
}

function namesModel(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) {
    return MODEL_NAME_IDENTIFIER.test(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return MODEL_NAME_IDENTIFIER.test(node.name.text);
  }
  return false;
}
