import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Globe, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NETWORK_STATUS_REFRESH_MS } from "../../../shared/defaults.ts";
import { networkStatusDtoSchema, type NETWORK_PROXY_REASONS, type NetworkStatusDto } from "../../../shared/dto/network.ts";
import type { RunMode } from "../../../shared/enums.ts";
import { useApi } from "../../api/context.tsx";
import { InlineNote } from "../../ui/notice.tsx";

const NETWORK_STATUS_KEY = ["network", "status"] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Whether the page is on screen; a hidden page (another tab, a minimised window) polls nothing. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * The network status, re-read every `NETWORK_STATUS_REFRESH_MS` while the page is visible and
 * once more when it comes back. Reading it probes nothing: the server only reports the proxy
 * configuration and the outcome of the last real request that went through it.
 */
export function useNetworkStatus() {
  const client = useApi();
  const visible = useDocumentVisible();
  const query = useQuery({
    queryKey: NETWORK_STATUS_KEY,
    queryFn: () => client.get("/api/network/status", networkStatusDtoSchema),
    refetchInterval: visible ? NETWORK_STATUS_REFRESH_MS : false,
    refetchIntervalInBackground: false,
  });
  const { refetch } = query;
  const wasVisible = useRef(visible);
  useEffect(() => {
    // Coming back from hidden: the line may be one change behind, so read it right away.
    if (visible && !wasVisible.current) void refetch();
    wasVisible.current = visible;
  }, [visible, refetch]);
  return query;
}

/** Whether proxied requests go through the Windows system proxy (desktop client) rather than a proxy from the environment. */
export function usesSystemProxy(status: NetworkStatusDto | undefined, mode: RunMode | undefined): boolean {
  return (status?.source ?? (mode === "server" ? "env" : "system")) === "system";
}

/**
 * `usesSystemProxy` from the status the line last read, without polling of its own; before the
 * first read the run mode decides.
 */
export function useSystemProxyRoute(): boolean {
  const client = useApi();
  const queryClient = useQueryClient();
  return usesSystemProxy(queryClient.getQueryData<NetworkStatusDto>(NETWORK_STATUS_KEY), client.mode);
}

type Tone = "plain" | "warn" | "danger";

const REASON_KEYS = {
  pac: "network.status.pac",
  socks: "network.status.socks",
  scheme: "network.status.scheme",
  unparsable: "network.status.unparsable",
  read_failed: "network.status.readFailed",
} as const satisfies Record<(typeof NETWORK_PROXY_REASONS)[number], string>;

function useAgo(): (at: number, now: number) => string {
  const { t } = useTranslation();
  return (at, now) => {
    const elapsed = Math.max(0, now - at);
    if (elapsed < MINUTE_MS) return t("network.ago.justNow");
    if (elapsed < HOUR_MS) return t("network.ago.minutes", { n: Math.floor(elapsed / MINUTE_MS) });
    if (elapsed < DAY_MS) return t("network.ago.hours", { n: Math.floor(elapsed / HOUR_MS) });
    return t("network.ago.days", { n: Math.floor(elapsed / DAY_MS) });
  };
}

/**
 * The status line's words and tone. It states the configuration, never "going through the proxy
 * right now": whether the proxy answers is only known from real requests, so the line turns to an
 * error only after the last one through the proxy failed, until one succeeds or the configuration
 * changes (the server then drops that outcome). In the desktop client the system proxy is named
 * with its address; a proxy from the environment (server mode) is only said to be used or not.
 */
function useStatusLine(): (status: NetworkStatusDto, now: number) => { text: string; tone: Tone } {
  const { t } = useTranslation();
  const ago = useAgo();
  // Same address for both protocols is written once; one protocol only says which.
  const systemManualLine = (status: NetworkStatusDto): string => {
    const http = status.proxy?.http;
    const https = status.proxy?.https;
    if (http !== undefined && https !== undefined) {
      const proxy = http === https ? http : t("network.status.proxyPair", { http, https });
      return t("network.status.systemManual", { proxy });
    }
    if (http !== undefined) return t("network.status.systemManualHttpOnly", { proxy: http });
    if (https !== undefined) return t("network.status.systemManualHttpsOnly", { proxy: https });
    return t("network.status.serverProxy");
  };
  return (status, now) => {
    const system = status.source === "system";
    const outcome = status.lastProxyOutcome;
    if (outcome !== undefined && !outcome.ok) {
      const time = ago(outcome.at, now);
      return { text: system ? t("network.status.lastFailedSystem", { time }) : t("network.status.lastFailedServer", { time }), tone: "danger" };
    }
    switch (status.state) {
      case "off":
        return { text: system ? t("network.status.systemOff") : t("network.status.serverDirect"), tone: "plain" };
      case "unsupported":
        // Only a PAC script, only SOCKS, a non-http address, or settings that cannot be read as any of them.
        return { text: t(REASON_KEYS[status.reason ?? "unparsable"]), tone: "warn" };
      case "error":
        return { text: t("network.status.readFailed"), tone: "warn" };
      case "manual": {
        const line = system ? systemManualLine(status) : t("network.status.serverProxy");
        return { text: status.pacIgnored === true && system ? t("network.status.withNote", { line, note: t("network.status.pacIgnored") }) : line, tone: "plain" };
      }
    }
  };
}

const TONE_CLASS: Readonly<Record<Tone, string>> = { plain: "", warn: "text-warn!", danger: "text-danger!" };

/**
 * The quiet line at the top of the model settings saying how Amber reaches the network. A
 * status that cannot be read shows nothing rather than a guess; the line is a live region, so a
 * failure that appears while the page is open is announced.
 */
export function NetworkStatusLine() {
  const { t } = useTranslation();
  const status = useNetworkStatus();
  const describe = useStatusLine();
  if (status.data === undefined) return null;
  // Reading the refresh time re-renders the line at every refresh, so "2 minutes ago" keeps
  // counting while the page is open.
  const line = describe(status.data, Math.max(Date.now(), status.dataUpdatedAt));
  const Icon = line.tone === "danger" ? CircleAlert : line.tone === "warn" ? TriangleAlert : Globe;
  return (
    <InlineNote
      role="status"
      aria-label={t("network.status.label")}
      className={`-mt-1 mb-3 ${TONE_CLASS[line.tone]}`}
      icon={<Icon size={14} aria-hidden="true" />}
      testId="network-status"
      data-tone={line.tone}
    >
      {line.text}
    </InlineNote>
  );
}
