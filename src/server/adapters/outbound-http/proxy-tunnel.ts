import { maxHeaderSize } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { RefinedErrorCode } from "../../../shared/errors.ts";
import { amberError } from "../../domain/errors.ts";
import type { ProxyEndpoint } from "../../ports/network-route.ts";
import { OutboundHttpError } from "../../ports/outbound-http.ts";

/** The connection a proxied request is sent on, and the means to tear it down at any stage. */
export interface ProxyTunnel {
  /**
   * https target: a TLS socket to the target through a CONNECT tunnel, certificate verified;
   * http target: the plain socket to the proxy. Rejects with a `network_proxy_failed` AmberError
   * when the proxy cannot be used, or an `OutboundHttpError` (`before_send`) when the target's
   * TLS handshake fails for any reason other than its certificate.
   */
  ready: Promise<Socket>;
  /** Destroys every socket opened for this request: the one to the proxy and the TLS one on it. */
  destroy(): void;
}

const HEADER_END = Buffer.from("\r\n\r\n", "latin1");
const AUTH_REQUIRED_STATUS = 407;

/** `Proxy-Authorization` for an endpoint carrying credentials. */
export function proxyAuthorization(endpoint: ProxyEndpoint): string | undefined {
  const { credentials } = endpoint;
  return credentials === undefined ? undefined : `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
}

function proxyFailure(code: RefinedErrorCode, message: string) {
  return amberError("network_proxy_failed", message, { code });
}

/**
 * Certificate verification failures as OpenSSL and Node report them; any of these through a
 * proxy most likely means the proxy replaced the certificate.
 */
function isCertificateError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ISSUER|SIGNATURE|ALTNAME|HOSTNAME/u.test(code);
}

/**
 * Opens the connection of one proxied request; one connection per request, never pooled, so a
 * new configuration applies to the next request at once. For an https target the proxy is asked
 * for `CONNECT host:port` (the only message carrying `Proxy-Authorization`) and TLS runs inside
 * the tunnel with SNI and ALPN `http/1.1`, verifying the target's certificate as usual. Every
 * failure here happens before any of the request reached the target.
 */
export function openProxyTunnel(target: URL, endpoint: ProxyEndpoint, tls: Pick<ConnectionOptions, "ca"> = {}): ProxyTunnel {
  const raw = netConnect({ host: endpoint.host, port: endpoint.port });
  let secure: TLSSocket | undefined;
  let finished = false;
  const destroy = (): void => {
    finished = true;
    secure?.destroy();
    raw.destroy();
  };
  const ready = new Promise<Socket>((resolve, reject) => {
    let connected = false;
    const fail = (error: Error): void => {
      if (!finished) {
        destroy();
        reject(error);
      }
    };
    const succeed = (socket: Socket): void => {
      if (finished) {
        socket.destroy();
        return;
      }
      raw.off("error", onRawError);
      raw.off("close", onRawClose);
      // The request owns the socket from here; closing it releases the tunnel underneath too.
      socket.once("close", () => raw.destroy());
      raw.on("error", () => socket.destroy());
      resolve(socket);
    };
    const onRawError = (): void =>
      fail(connected ? proxyFailure("network_proxy_failed.rejected", "the proxy dropped the connection") : proxyFailure("network_proxy_failed.unreachable", "cannot connect to the proxy"));
    const onRawClose = (): void =>
      fail(connected ? proxyFailure("network_proxy_failed.rejected", "the proxy closed the connection") : proxyFailure("network_proxy_failed.unreachable", "cannot connect to the proxy"));
    raw.on("error", onRawError);
    raw.on("close", onRawClose);
    raw.once("connect", () => {
      connected = true;
      if (target.protocol !== "https:") {
        succeed(raw);
        return;
      }
      const authority = `${target.hostname}:${target.port === "" ? "443" : target.port}`;
      const authorization = proxyAuthorization(endpoint);
      raw.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization === undefined ? "" : `Proxy-Authorization: ${authorization}\r\n`}\r\n`, "latin1");
      readConnectResponse(raw, (outcome) => {
        if (outcome.kind === "failed") {
          fail(outcome.error);
          return;
        }
        if (outcome.rest.length > 0) {
          raw.unshift(outcome.rest);
        }
        raw.off("error", onRawError);
        raw.off("close", onRawClose);
        const identity = target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname;
        const servername = isIP(identity) === 0 ? identity : undefined;
        const socket = tlsConnect({
          socket: raw,
          ...(servername === undefined ? {} : { servername }),
          // The certificate must name the target, never the proxy the socket was opened to: an
          // IP literal sends no SNI, and Node would otherwise check it against the proxy's host.
          checkServerIdentity: (_host, certificate) => checkServerIdentity(identity, certificate),
          ALPNProtocols: ["http/1.1"],
          ...(tls.ca === undefined ? {} : { ca: tls.ca }),
        });
        secure = socket;
        const onTlsError = (error: Error): void =>
          fail(isCertificateError(error) ? proxyFailure("network_proxy_failed.tls", "certificate check failed through the proxy") : new OutboundHttpError("before_send", "network", { cause: error }));
        const onTlsClose = (): void => fail(new OutboundHttpError("before_send", "network"));
        socket.once("error", onTlsError);
        socket.once("close", onTlsClose);
        socket.once("secureConnect", () => {
          socket.off("error", onTlsError);
          socket.off("close", onTlsClose);
          succeed(socket);
        });
      }, fail);
    });
  });
  // Rejections are observed by the caller; this keeps an abandoned tunnel from going unhandled.
  ready.catch(() => undefined);
  return { ready, destroy };
}

type ConnectOutcome = { kind: "established"; rest: Buffer } | { kind: "failed"; error: Error };

/**
 * Reads the proxy's answer to CONNECT up to the blank line. 2xx establishes the tunnel (bytes
 * past the header belong to it); 407 asks for credentials Amber does not have; anything else,
 * or a header beyond Node's own header size limit, is a refusal.
 */
function readConnectResponse(raw: Socket, done: (outcome: ConnectOutcome) => void, fail: (error: Error) => void): void {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(HEADER_END);
    if (end < 0) {
      if (buffered.length > maxHeaderSize) {
        raw.off("data", onData);
        fail(proxyFailure("network_proxy_failed.rejected", "the proxy's CONNECT answer is too large"));
      }
      return;
    }
    raw.off("data", onData);
    raw.pause();
    const statusLine = buffered.subarray(0, buffered.indexOf("\r\n")).toString("latin1");
    const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(statusLine);
    const code = status === null ? undefined : Number(status[1]);
    if (code !== undefined && code >= 200 && code < 300) {
      done({ kind: "established", rest: buffered.subarray(end + HEADER_END.length) });
    } else if (code === AUTH_REQUIRED_STATUS) {
      done({ kind: "failed", error: proxyFailure("network_proxy_failed.auth_required", "the proxy requires authentication") });
    } else {
      done({ kind: "failed", error: proxyFailure("network_proxy_failed.rejected", `the proxy refused CONNECT${code === undefined ? "" : ` with ${code}`}`) });
    }
  };
  raw.on("data", onData);
}
