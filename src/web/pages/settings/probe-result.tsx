import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PROBE_CHECK_FLAGS, type ProbeResultDto } from "../../../shared/dto/provider.ts";
import type { AppError } from "../../../shared/errors.ts";
import { ApiError } from "../../api/client.ts";
import { Callout } from "../../ui/notice.tsx";

/** Failures that say the model cannot be used as configured, as opposed to "could not tell". */
const UNAVAILABLE_CAUSES: Readonly<Record<string, "modelNotFound" | "auth" | "invalidRequest">> = {
  "llm_failed.model_not_found": "modelNotFound",
  "llm_failed.auth": "auth",
  "llm_failed.invalid_request": "invalidRequest",
};

const UNCONFIRMED_CAUSES: Readonly<Record<string, "quota" | "unreachable" | "overloaded" | "refused">> = {
  "llm_failed.quota": "quota",
  "llm_failed.unreachable": "unreachable",
  "llm_failed.overloaded": "overloaded",
  "llm_failed.refused": "refused",
};

/**
 * `ok`: it works; `plain`: connected, with a detail; `warn`: the test could not tell, try again
 * later; `danger`: the model cannot be used as configured, with what to fix.
 */
type Summary = { tone: "ok" | "plain" | "warn" | "danger"; text: string; testId: string; fix?: string };

function retryAfterSeconds(error: AppError): number | undefined {
  const value = error.details?.["retryAfterMs"];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.ceil(value / 1000) : undefined;
}

/**
 * The one-line verdict of a failed test. Only Amber's own wording is shown: the upstream text
 * stays out (it is the vendor's raw English and adds nothing a user can act on here).
 */
function useFailureSummary(): (error: unknown) => Summary {
  const { t } = useTranslation();
  return (error) => {
    if (!(error instanceof ApiError)) {
      return { tone: "warn", text: t("settings.models.probe.unconfirmed", { reason: t("settings.models.probe.cause.unknown") }), testId: "probe-unconfirmed" };
    }
    const appError = error.error;
    if (appError.class === "conflict") {
      // The configuration changed while the test ran; the server words what to do.
      return { tone: "warn", text: appError.userMessage, testId: "probe-conflict" };
    }
    const unavailable = UNAVAILABLE_CAUSES[appError.code] ?? (appError.class === "llm_capability" ? "invalidRequest" : undefined);
    if (unavailable !== undefined) {
      return {
        tone: "danger",
        text: t("settings.models.probe.unavailable", { reason: t(`settings.models.probe.cause.${unavailable}`) }),
        testId: "probe-unavailable",
        fix: t(`settings.models.probe.fix.${unavailable}`),
      };
    }
    let reason: string;
    if (appError.class === "llm_rate_limited") {
      const seconds = retryAfterSeconds(appError);
      reason = seconds === undefined ? t("settings.models.probe.cause.rateLimited") : t("settings.models.probe.cause.rateLimitedIn", { seconds });
    } else if (appError.class === "llm_outcome_unknown") {
      reason = t("settings.models.probe.cause.outcomeUnknown");
    } else {
      const cause = UNCONFIRMED_CAUSES[appError.code];
      reason = cause !== undefined ? t(`settings.models.probe.cause.${cause}`) : appError.userMessage !== "" ? appError.userMessage : t("settings.models.probe.cause.unknown");
    }
    return { tone: "warn", text: t("settings.models.probe.unconfirmed", { reason }), testId: "probe-unconfirmed" };
  };
}

/**
 * What one "test connection" found for a model: a verdict line, then a line for each capability
 * the test could not settle. What it did settle shows in the model's capability table, which the
 * test refreshes, so it is not repeated here. Every state is written out in words; colour only
 * repeats it. Success is a quiet
 * line; a test that could not tell is a caution, a model that cannot be used an error notice that
 * says what to fix. It is meant to sit
 * inside a live region the caller keeps mounted, so a new verdict is announced. `regionHint` adds
 * that a rejected key may belong to another region, for services whose keys are per region.
 * A result carries a quiet tag with the path the test request actually took (a result without
 * one went direct); `systemProxy` names the proxy as the Windows system proxy (desktop client)
 * rather than a proxy from the environment.
 */
export function ProbeResult({
  result,
  error,
  regionHint,
  systemProxy = false,
}: {
  result?: ProbeResultDto | undefined;
  error?: unknown;
  regionHint: boolean;
  systemProxy?: boolean;
}) {
  const { t } = useTranslation();
  const failure = useFailureSummary();
  if (result === undefined && error === undefined) {
    return null;
  }
  const summary: Summary =
    result === undefined
      ? failure(error)
      : result.basic.status === "connected"
        ? { tone: "ok", text: t("settings.models.probe.connected", { ms: Math.round(result.basic.latencyMs) }), testId: "probe-connected" }
        : { tone: "plain", text: t("settings.models.probe.incomplete"), testId: "probe-incomplete" };
  const authFailed = error instanceof ApiError && error.error.code === "llm_failed.auth";
  const regionLine =
    authFailed && regionHint ? (
      <p data-testid="probe-region-hint">
        {t("settings.models.probe.regionMismatch")}
      </p>
    ) : null;
  const route = result === undefined ? undefined : result.route === "proxy" ? (systemProxy ? "systemProxy" : "proxy") : "direct";
  const verdict =
    summary.tone === "ok" || summary.tone === "plain" ? (
      <p className={`flex flex-wrap items-start gap-x-1.5 gap-y-0.5 text-note ${summary.tone === "ok" ? "text-ok" : "text-ink"}`}>
        {summary.tone === "ok" ? <CircleCheck size={14} className="mt-[3px] shrink-0" aria-hidden="true" /> : null}
        <span data-testid={summary.testId}>{summary.text}</span>
        {route === undefined ? null : (
          <span className="mt-0.5 shrink-0 rounded border border-line px-1 text-[11px] leading-4 font-normal text-muted" data-testid="probe-route" data-route={route}>
            {t(`network.route.${route}`)}
          </span>
        )}
      </p>
    ) : (
      <Callout tone={summary.tone === "danger" ? "error" : "warn"} density="compact">
        <p className="font-medium" data-testid={summary.testId}>
          {summary.text}
        </p>
        {summary.fix === undefined ? null : (
          <p data-testid="probe-fix">
            {summary.fix}
          </p>
        )}
        {regionLine}
      </Callout>
    );
  // The capability table above already shows what the test confirmed, so only what it could not
  // tell is spelled out here, with why: the table would just say "unknown".
  const unconfirmed = result === undefined ? [] : PROBE_CHECK_FLAGS.flatMap((flag) => {
    const check = result.checks.find((item) => item.flag === flag);
    return check === undefined || check.result === "inconclusive" ? [{ flag, reason: check?.reason }] : [];
  });
  return (
    <div className="mt-2" data-testid="probe-result">
      {verdict}
      {unconfirmed.length === 0 ? null : (
        <ul className="mt-1 flex flex-col gap-0.5 text-note text-muted" data-testid="probe-checks">
          {unconfirmed.map(({ flag, reason }) => (
            <li key={flag} data-testid={`probe-check-${flag}`} data-result="inconclusive">
              {reason === undefined
                ? t("settings.models.probe.unconfirmedCheck", { check: t(`settings.models.capability.${flag}`) })
                : t("settings.models.probe.unconfirmedCheckBecause", { check: t(`settings.models.capability.${flag}`), reason: t(`settings.models.probe.reason.${reason}`) })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
