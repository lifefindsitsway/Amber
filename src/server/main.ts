import { FILE_GRANT_KEY_ENV } from "./adapters/file-grant/hmac-file-grant.ts";
import { MASTER_KEY_ENV } from "./adapters/secret-store/master-key.ts";
import { listenSystemProxyMessages, readProxyConfiguration, SystemProxyState } from "./adapters/system-proxy/index.ts";
import { compose, listenAddress, readConfig, startupLog } from "./compose.ts";
import { isAmberError } from "./domain/errors.ts";
import { runRestoreCommand } from "./restore.ts";

/**
 * Sidecar / container entry point.
 *
 * `local`: the desktop shell spawns this process with an explicit environment, reads the
 * single `READY` line from stdout and keeps stdin open for the sidecar's lifetime: stdin
 * reaching EOF is the request to shut down, which works on Windows where POSIX signals do
 * not exist. The shell also writes each change of the Windows system proxy to stdin as one
 * JSON line; stdin is read from before READY on, so none is missed.
 *
 * The proxy configuration is read once at start, from `AMBER_SYSTEM_PROXY` when the shell
 * passed it and from the standard proxy variables otherwise.
 *
 * `server`: the development and test mode; listens on `AMBER_HOST:AMBER_PORT` (loopback by
 * default), serves the SPA and stops on SIGINT / SIGTERM.
 *
 * `restore …`: the offline restore command, dispatched before anything else.
 */

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const address = config.mode === "server" ? listenAddress(process.env) : undefined;
  // Read once: nothing later in this process needs these variables.
  delete process.env[FILE_GRANT_KEY_ENV];
  const network = new SystemProxyState(readProxyConfiguration(process.env));
  const composition = await compose({ ...config, network });
  delete process.env[MASTER_KEY_ENV];

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    startupLog("shutdown", { reason });
    await composition.shutdown();
    if (config.mode === "local") {
      process.stdin.destroy();
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (config.mode === "local") {
    listenSystemProxyMessages(process.stdin, network, startupLog);
    process.stdin.on("end", () => void shutdown("stdin_closed"));
    process.stdin.on("error", () => void shutdown("stdin_error"));
    process.stdin.resume();
    await composition.app.listen({ host: "127.0.0.1", port: 0 });
    if (closing) {
      return;
    }
    const bound = composition.app.server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("server did not bind a TCP port");
    }
    process.stdout.write(`READY ${JSON.stringify({ port: bound.port, pid: process.pid })}\n`);
    // Sweeping, recovery and scheduling start after READY so none can delay it.
    await composition.startBackground();
    return;
  }

  await composition.app.listen(address ?? listenAddress(process.env));
  startupLog("listening", { host: address?.host, port: address?.port, publicOrigin: config.publicOrigin });
  // Server mode is for development and testing, not a delivered product: said once at
  // start-up so nobody mistakes it for one.
  startupLog("server_mode_development_only");
  if (composition.setupToken !== undefined) {
    // The one deliberate console exception for a secret: a one-time bootstrap token may be
    // printed while it is valid, as a plain line for the operator, never a structured log
    // record.
    process.stderr.write(
      `Amber is not initialized. Open ${config.publicOrigin}/setup and enter this one-time setup token ` +
        `(valid ${composition.setupToken.ttlMinutes} minutes): ${composition.setupToken.value}\n`,
    );
  }
  await composition.startBackground();
}

const entry: Promise<unknown> =
  process.argv[2] === "restore"
    ? runRestoreCommand(process.argv.slice(3)).then((code) => {
        process.exitCode = code;
      })
    : main();

entry.catch((error: unknown) => {
  startupLog("startup_failed", {
    ...(isAmberError(error) ? { code: error.appError.code } : {}),
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
