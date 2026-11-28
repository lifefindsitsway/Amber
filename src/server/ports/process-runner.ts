export interface ProcessSpec {
  /** Executable path; arguments are passed as an array and never through a shell. */
  command: string;
  args: readonly string[];
  cwd?: string;
  /**
   * The complete child environment. Nothing is inherited implicitly: packager-injected
   * variables would leak into tools, and `AMBER_SECRET_KEY` must never reach a child
   * process. Build it with `childProcessEnv`.
   */
  env: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface ProcessRunOptions {
  /** Aborting kills the whole process tree, not just the direct child. */
  signal: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs yt-dlp, ffmpeg, ffprobe and Deno as child processes. Implementations reject a spec
 * whose environment carries a variable from `FORBIDDEN_CHILD_ENV`, as a second line of
 * defense behind `childProcessEnv`.
 */
export interface ProcessRunner {
  run(spec: ProcessSpec, opts: ProcessRunOptions): Promise<ProcessResult>;
}

/**
 * Parent variables a child tool may see. Everything else, including every `AMBER_*`
 * variable, is withheld. Tools are always started by absolute path, so PATH is not needed.
 * The proxy variables are withheld too: FFmpeg and ffprobe only touch local files, and yt-dlp
 * gets a proxy only from its own run's route decision, which then sets it for that child alone.
 * A proxy URL may carry credentials, so child environments are never logged.
 */
export const CHILD_ENV_ALLOWLIST = [
  "SystemRoot",
  "WINDIR",
  // Windows profile folders: yt-dlp `--cookies-from-browser` finds the browsers' profiles
  // under them (`%APPDATA%` for Firefox, `%LOCALAPPDATA%` for Chrome and Edge).
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
] as const;

/**
 * Variables that must never reach a child process: the master key, the sidecar startup
 * token and the file grant key.
 */
export const FORBIDDEN_CHILD_ENV = ["AMBER_SECRET_KEY", "AMBER_SIDECAR_TOKEN", "AMBER_FILE_GRANT_KEY"] as const;

/** Throws when `env` carries a forbidden variable; names only, values are never echoed. */
export function assertChildEnvSafe(env: Readonly<Record<string, string>>): void {
  const leaked = FORBIDDEN_CHILD_ENV.filter((name) => Object.hasOwn(env, name));
  if (leaked.length > 0) {
    throw new TypeError(`child process environment must not contain ${leaked.join(", ")}`);
  }
}

/**
 * Builds the complete environment of a child process: the allowlisted parent variables
 * plus explicit additions. Adding a forbidden variable is a programming error and throws.
 */
export function childProcessEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  assertChildEnvSafe(extra);
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined && value !== "") {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}
