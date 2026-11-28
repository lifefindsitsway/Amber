import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YtDlp } from "../../../src/server/adapters/platform/yt-dlp.ts";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../../src/server/ports/outbound-http.ts";
import type { PlatformCredential } from "../../../src/server/ports/platform-source.ts";
import type { ProcessResult, ProcessRunner, ProcessRunOptions, ProcessSpec } from "../../../src/server/ports/process-runner.ts";

/**
 * Scripted process and HTTP doubles for platform adapter tests: every call is recorded
 * and answered by a handler, so nothing leaves the machine.
 */

export interface ScriptedProcess {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Delivered through `onStdoutLine` before the run resolves; defaults to the lines of `stdout`, as a real runner does. */
  stdoutLines?: readonly string[];
}

export type ProcessHandler = (spec: ProcessSpec, opts: ProcessRunOptions) => ScriptedProcess | Promise<ScriptedProcess>;

export class ScriptedRunner implements ProcessRunner {
  readonly specs: ProcessSpec[] = [];
  handler: ProcessHandler;

  constructor(handler: ProcessHandler = () => ({})) {
    this.handler = handler;
  }

  async run(spec: ProcessSpec, opts: ProcessRunOptions): Promise<ProcessResult> {
    this.specs.push(spec);
    const answer = await this.handler(spec, opts);
    const lines = answer.stdoutLines ?? (answer.stdout === undefined || answer.stdout === "" ? [] : answer.stdout.replace(/\n$/, "").split("\n"));
    for (const line of lines) {
      opts.onStdoutLine?.(line);
    }
    return { exitCode: answer.exitCode ?? 0, signal: null, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  }
}

export interface ScriptedResponse {
  status?: number;
  body?: string | object;
  headers?: Record<string, string>;
  /** Each `Set-Cookie` header as the platform sends it. */
  setCookies?: string[];
}

export type HttpHandler = (request: OutboundRequest) => ScriptedResponse | Error | Promise<ScriptedResponse | Error>;

/** `onDestroy` is told when the caller discards the response unread. */
export function outboundResponse(answer: ScriptedResponse, onDestroy?: () => void): OutboundResponse {
  const text = answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
  const bytes = new TextEncoder().encode(text);
  return {
    status: answer.status ?? 200,
    headers: new Map(Object.entries(answer.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    ...(answer.setCookies === undefined ? {} : { setCookies: answer.setCookies }),
    body: (async function* () {
      yield bytes;
    })(),
    text: async () => text,
    route: "direct",
    destroy: () => onDestroy?.(),
  };
}

const recorded: OutboundRequest[] = [];

/**
 * Every request any `ScriptedHttp` recorded since the last call, which are then forgotten:
 * lets a test file check a property of all requests its tests made, in an `afterEach`.
 */
export function drainScriptedRequests(): OutboundRequest[] {
  return recorded.splice(0);
}

export class ScriptedHttp implements OutboundHttpClient {
  readonly requests: OutboundRequest[] = [];
  /** URLs of the responses the caller discarded unread, in order. */
  readonly destroyed: string[] = [];
  handler: HttpHandler;

  constructor(handler: HttpHandler = () => ({ status: 404 })) {
    this.handler = handler;
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    recorded.push(request);
    const answer = await this.handler(request);
    if (answer instanceof Error) {
      throw answer;
    }
    return outboundResponse(answer, () => this.destroyed.push(request.url));
  }

  /** Requests whose URL path is `path`. */
  to(path: string): OutboundRequest[] {
    return this.requests.filter((request) => new URL(request.url).pathname === path);
  }
}

/** The value following `flag` in an argument list. */
export function argAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

export const BIN_DIR = "/opt/amber/bin";

/** A YtDlp over a scripted runner and a fresh temporary data directory. */
export function scriptedYtDlp(handler?: ProcessHandler): { ytDlp: YtDlp; runner: ScriptedRunner; dataDir: string } {
  const runner = new ScriptedRunner(handler);
  const dataDir = mkdtempSync(join(tmpdir(), "amber-ytdlp-"));
  return { ytDlp: new YtDlp({ runner, binDir: BIN_DIR, dataDir, env: { LANG: "C.UTF-8" } }), runner, dataDir };
}

/** One Netscape cookies.txt line; values in tests are always placeholders. */
export function cookieLine(domain: string, name: string, expires = 0): string {
  return [domain, "TRUE", "/", "TRUE", String(expires), name, "<placeholder>"].join("\t");
}

export function credential(platform: PlatformCredential["platform"], lines: readonly string[]): PlatformCredential {
  return { platform, cookies: async () => `# Netscape HTTP Cookie File\n${lines.join("\n")}\n` };
}

export const signal = (): AbortSignal => new AbortController().signal;
