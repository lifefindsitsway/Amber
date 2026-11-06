import type { PriceSnapshot } from "../../shared/model-pricing.ts";
import type { AsrUsage, RequestStartInfo } from "../domain/usage.ts";
import type { AsrJobReport } from "../ports/asr-provider.ts";
import type { Logger } from "../ports/logger.ts";
import type { AsrJobReportFill, Repository } from "../ports/repository.ts";

/** What an ASR adapter reported as a paid request was about to leave, ready to go into a usage row. */
export type AsrSendContext = Required<Pick<AsrUsage, "sentAt" | "credentialVersion" | "credentialSetAt">> & Pick<AsrUsage, "priceSnapshot">;

/**
 * Collects the send time, the key version and the model's price at the moment the adapter
 * reports the request is leaving. The price is read from the profile as it is then, so a
 * price edited or a key replaced while the call waited is recorded as sent. Reading the
 * price must never fail the call: on error the snapshot stays empty and only the error's
 * name is logged. A context for a request that turns out never to have left is dropped with
 * the attempt.
 */
export function captureAsrSend(
  repository: Pick<Repository, "withTransaction">,
  logger: Logger | undefined,
  profile: { userId: string; id: string },
  modelId: string,
): { onRequestStart: (info: RequestStartInfo) => void; context: () => AsrSendContext | undefined } {
  let captured: AsrSendContext | undefined;
  return {
    onRequestStart: (info) => {
      let priceSnapshot: PriceSnapshot | undefined;
      try {
        priceSnapshot = repository.withTransaction((scope) => scope.asrProfiles.getModelPricing(profile.userId, profile.id, modelId));
      } catch (error) {
        logger?.warn("asr_price_snapshot_failed", { asrProfileId: profile.id, modelId, error: error instanceof Error ? error.name : "unknown" });
      }
      captured = {
        sentAt: info.sentAt,
        credentialVersion: info.credential.versionId,
        credentialSetAt: info.credential.setAt,
        ...(priceSnapshot === undefined ? {} : { priceSnapshot }),
      };
    },
    context: () => captured,
  };
}

/** A job report as the fields it fills into the job's usage row. */
export function fillOf(report: AsrJobReport): AsrJobReportFill {
  return {
    jobOutcome: report.remote,
    ...report.usage,
    ...(report.rawUsageJson === undefined ? {} : { rawUsageJson: report.rawUsageJson }),
  };
}

/**
 * Completes a job's usage row with its remote end state, in a transaction of its own. This
 * is bookkeeping about an already-made call: any failure is logged by name only and never
 * reaches the caller, so it cannot change a unit's state, a transcript or a retry.
 */
export function fillAsrJobReport(
  repository: Pick<Repository, "withTransaction">,
  logger: Logger | undefined,
  ownerUserId: string,
  usageId: string,
  report: AsrJobReport,
): void {
  try {
    const found = repository.withTransaction((scope) => scope.asrUsage.fillJobReport(ownerUserId, usageId, fillOf(report)));
    if (!found) {
      logger?.warn("asr_job_report_without_usage_row", { remote: report.remote });
    }
  } catch (error) {
    logger?.warn("asr_job_report_not_recorded", { remote: report.remote, error: error instanceof Error ? error.name : "unknown" });
  }
}
