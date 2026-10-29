import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASES_PAGE_URL } from "../shared/app-identity.ts";
import { CHANGELOG_FILE, releaseVersionOf } from "./check-versions.ts";
import { localTestEndpoint } from "./updater-config.ts";

/**
 * Writes the updater manifest `latest.json` next to a signed build:
 *
 *   pnpm release:manifest -- --dir <artifact directory> [--notes-file <file>] [--local-test <base URL>]
 *
 * The directory holds exactly one NSIS installer (`*-setup.exe`) and its `.sig`. `signature`
 * is the `.sig` content as written by the signer, and `url` the asset of the `v<version>` GitHub
 * Release. `notes` is what the update dialog shows: the text of `--notes-file`, trimmed, when
 * one is given (a published release uses the short public notes the maintainer reviewed,
 * while the local changelog keeps the full record); otherwise the changelog section of the
 * release version (empty when there is none). A notes file that is missing or empty is an
 * error, so a release never goes out with notes left blank by mistake. `--local-test <base URL>` points `url` at that loopback directory instead, for the
 * candidate upgrade test; it never names anything else.
 */

export const LATEST_JSON = "latest.json";
const WINDOWS_PLATFORM = "windows-x86_64";
const INSTALLER_SUFFIX = "-setup.exe";

export interface LatestJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/** The single installer in `dir` that has a `.sig` beside it. */
export function findSignedInstaller(dir: string): { installer: string; signature: string } {
  const names = readdirSync(dir);
  const installers = names.filter((name) => name.endsWith(INSTALLER_SUFFIX));
  if (installers.length !== 1) {
    throw new Error(`expected exactly one *${INSTALLER_SUFFIX} in the artifact directory, found ${installers.length}`);
  }
  const installer = installers[0] as string;
  if (!names.includes(`${installer}.sig`)) {
    throw new Error(`${installer}.sig is missing; sign the build first`);
  }
  return { installer, signature: `${installer}.sig` };
}

/** The body of the `## [<version>]` section of a Keep a Changelog document, trimmed; empty when absent. */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[${version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\]`, "u").test(line));
  if (start === -1) {
    return "";
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/u.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** RFC 3339 in UTC to the second, the form the updater parses. */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

export function renderLatestJson(input: {
  version: string;
  changelog: string;
  installer: string;
  signature: string;
  now: Date;
  /** Release notes that replace the changelog section; must not be blank. */
  notes?: string;
  localTest?: string;
}): LatestJson {
  const base = input.localTest === undefined ? `${RELEASES_PAGE_URL}/download/v${input.version}/` : appendSlash(localTestEndpoint(input.localTest));
  return {
    version: input.version,
    notes: input.notes === undefined ? changelogSection(input.changelog, releaseVersionOf(input.version)) : nonBlankNotes(input.notes),
    pub_date: rfc3339(input.now),
    platforms: { [WINDOWS_PLATFORM]: { signature: input.signature, url: `${base}${encodeURIComponent(input.installer)}` } },
  };
}

function nonBlankNotes(notes: string): string {
  const trimmed = notes.trim();
  if (trimmed === "") {
    throw new Error("--notes-file is empty");
  }
  return trimmed;
}

function appendSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function parseArgs(argv: readonly string[]): { dir: string; notesFile?: string; localTest?: string } {
  let dir: string | undefined;
  let notesFile: string | undefined;
  let localTest: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dir") {
      dir = argv[++index];
    } else if (arg === "--notes-file") {
      notesFile = argv[++index];
      if (notesFile === undefined) {
        throw new Error("--notes-file needs a file");
      }
    } else if (arg === "--local-test") {
      localTest = argv[++index];
      if (localTest === undefined) {
        throw new Error("--local-test needs a URL");
      }
    } else if (arg !== "--") {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (dir === undefined) {
    throw new Error("usage: pnpm release:manifest -- --dir <artifact directory> [--notes-file <file>] [--local-test <base URL>]");
  }
  return { dir, ...(notesFile === undefined ? {} : { notesFile }), ...(localTest === undefined ? {} : { localTest }) };
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir);
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  let changelog = "";
  try {
    changelog = readFileSync(join(root, CHANGELOG_FILE), "utf8");
  } catch {
    // Without a changelog the notes stay empty; `check:versions --release` guards releases.
  }
  // Read before anything is written: a missing notes file stops here with no latest.json.
  const notes = args.notesFile === undefined ? undefined : readFileSync(resolve(args.notesFile), "utf8");
  const { installer, signature } = findSignedInstaller(dir);
  const latest = renderLatestJson({
    version,
    changelog,
    installer,
    signature: readFileSync(join(dir, signature), "utf8"),
    now: new Date(),
    ...(notes === undefined ? {} : { notes }),
    ...(args.localTest === undefined ? {} : { localTest: args.localTest }),
  });
  writeFileSync(join(dir, LATEST_JSON), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`wrote ${LATEST_JSON}: ${latest.version} → ${latest.platforms[WINDOWS_PLATFORM]?.url}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`release-manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
