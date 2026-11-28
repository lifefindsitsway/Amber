import { describe, expect, it } from "vitest";
import {
  childProcessEnv,
  FORBIDDEN_CHILD_ENV,
  type ProcessResult,
  type ProcessRunOptions,
  type ProcessRunner,
  type ProcessSpec,
} from "../../../src/server/ports/process-runner.ts";

/** Stub runner that records the specs it is given instead of starting anything. */
class RecordingRunner implements ProcessRunner {
  readonly specs: ProcessSpec[] = [];

  run(spec: ProcessSpec, _opts: ProcessRunOptions): Promise<ProcessResult> {
    this.specs.push(spec);
    return Promise.resolve({ exitCode: 0, signal: null, stdout: "", stderr: "" });
  }
}

/** What a sidecar's own environment looks like: the key and token are present in the parent. */
const PARENT = {
  AMBER_MODE: "local",
  AMBER_SECRET_KEY: "<placeholder master key>",
  AMBER_SIDECAR_TOKEN: "<placeholder token>",
  AMBER_DATA_DIR: "/data",
  PATH: "/usr/bin",
  HOME: "/home/amber",
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Temp",
  APPDATA: "C:\\Users\\u\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  USERPROFILE: "C:\\Users\\u",
  LANG: "zh_CN.UTF-8",
};

describe("child process environment contract", () => {
  it("a spec built with childProcessEnv never carries AMBER_SECRET_KEY or any AMBER_ variable", async () => {
    const runner = new RecordingRunner();
    await runner.run(
      { command: "/opt/amber/bin/ffprobe", args: ["-version"], env: childProcessEnv(PARENT, { FFREPORT: "level=32" }) },
      { signal: new AbortController().signal },
    );
    const keys = Object.keys(runner.specs[0]?.env ?? {}).sort();
    // The profile folders locate browser profiles for `--cookies-from-browser`; the user profile itself stays out.
    expect(keys).toEqual(["APPDATA", "FFREPORT", "LANG", "LOCALAPPDATA", "SystemRoot", "TEMP"]);
    expect(keys).not.toContain("AMBER_SECRET_KEY");
    expect(keys.filter((key) => key.startsWith("AMBER_"))).toEqual([]);
  });

  it("throws when a forbidden variable is added explicitly, naming it without its value", () => {
    for (const name of FORBIDDEN_CHILD_ENV) {
      expect(() => childProcessEnv(PARENT, { [name]: "<value that must not be echoed>" })).toThrow(name);
      expect(() => childProcessEnv(PARENT, { [name]: "<value that must not be echoed>" })).not.toThrow(/must not be echoed/);
    }
  });

  it("withholds every proxy variable: FFmpeg and ffprobe only touch local files, and yt-dlp gets its proxy per run", () => {
    const parent = {
      ...PARENT,
      HTTP_PROXY: "http://proxy-user:proxy-pass@127.0.0.1:3128",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      ALL_PROXY: "socks5://127.0.0.1:1080",
      NO_PROXY: "localhost",
      http_proxy: "http://127.0.0.1:3128",
      https_proxy: "http://127.0.0.1:3128",
      all_proxy: "socks5://127.0.0.1:1080",
      no_proxy: "localhost",
      AMBER_SYSTEM_PROXY: '{"v":1}',
    };
    const env = childProcessEnv(parent, { FFREPORT: "level=32" });
    expect(Object.keys(env).filter((name) => /proxy/i.test(name))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain("127.0.0.1");
  });

  it("skips empty allowlisted variables", () => {
    expect(childProcessEnv({ TEMP: "", TMP: "/tmp" })).toEqual({ TMP: "/tmp" });
  });
});
