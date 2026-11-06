import { Switch } from "radix-ui";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  decodeModelKey,
  USAGE_UNPRICED_REASON_GROUP,
  type UsageSummaryResponse,
  type UsageUnpricedGroup,
} from "../../../shared/dto/usage-analytics.ts";
import { formatCompactCount, formatCount, formatMoney } from "../../format.ts";
import { audioText } from "./usage-present.ts";

const GROUPS: readonly UsageUnpricedGroup[] = ["price", "usage", "history"];

/** Where a price is set: the transcription section for ASR models, else the model section. */
function priceSettingsPath(modelKeys: readonly string[]): string {
  const modality = modelKeys.map((key) => decodeModelKey(key)?.[0]).find((value) => value !== undefined);
  return modality === "asr" ? "/settings/transcription" : "/settings/models";
}

/**
 * The cost details popover: why requests are left out of the estimate (grouped by what the
 * user can do about it), how much of each quantity the estimate covers, and the simulation.
 */
export function UsageCostDetail(props: {
  response: UsageSummaryResponse;
  simulate: boolean;
  onSimulate: (on: boolean) => void;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const { costDetail } = props.response;
  const coverage = [
    { id: "llmTokens" as const, counted: costDetail.coverage.llmTokens.counted, total: costDetail.coverage.llmTokens.total, text: formatCompactCount },
    { id: "asrTokens" as const, counted: costDetail.coverage.asrTokens.counted, total: costDetail.coverage.asrTokens.total, text: formatCompactCount },
    { id: "audioMs" as const, counted: costDetail.coverage.audioMs.counted, total: costDetail.coverage.audioMs.total, text: (value: string) => audioText(value, t) },
  ].filter((row) => row.total !== "0");
  const simulated = costDetail.simulated;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">{t("usage.detail.note")}</p>

      <section aria-label={t("usage.detail.unpricedTitle")} className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">{t("usage.detail.unpricedTitle")}</h3>
        {costDetail.unpriced.length === 0 ? <p className="text-xs text-muted">{t("usage.detail.allCounted")}</p> : null}
        {GROUPS.map((group) => {
          const rows = costDetail.unpriced.filter((item) => USAGE_UNPRICED_REASON_GROUP[item.reason] === group);
          if (rows.length === 0) return null;
          return (
            <div key={group} data-testid={`usage-unpriced-${group}`}>
              <p className="mb-1 text-xs text-muted">{t(`usage.detail.group.${group}`)}</p>
              <ul className="flex flex-col gap-1">
                {rows.map((item) => (
                  <li key={item.reason} className="flex items-center gap-2" data-testid={`usage-unpriced-${item.reason}`}>
                    <span className="min-w-0 flex-1 truncate" title={t(`usage.reason.${item.reason}`)}>
                      {t(`usage.reason.${item.reason}`)}
                    </span>
                    <span className="tabular-nums">{t("usage.detail.times", { n: formatCount(item.requests) })}</span>
                    {group === "price" ? (
                      <Link to={priceSettingsPath(item.modelKeys)} className="shrink-0 text-xs text-accent hover:underline" onClick={props.onNavigate}>
                        {t("usage.detail.setPrice")}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      {coverage.length === 0 ? null : (
        <section aria-label={t("usage.detail.coverageTitle")} className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{t("usage.detail.coverageTitle")}</h3>
          <ul className="flex flex-col gap-1">
            {coverage.map((row) => (
              <li key={row.id} className="flex justify-between gap-2" data-testid={`usage-coverage-${row.id}`}>
                <span className="text-muted">{t(`usage.detail.coverage.${row.id}`)}</span>
                <span className="tabular-nums">{`${row.text(row.counted)} / ${row.text(row.total)}`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span>{t("usage.detail.simulate")}</span>
          <Switch.Root
            checked={props.simulate}
            onCheckedChange={props.onSimulate}
            className="relative h-5 w-9 shrink-0 rounded-full bg-sunken outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=checked]:bg-accent"
            data-testid="usage-simulate"
          >
            <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-[18px]" />
          </Switch.Root>
        </label>
        {props.simulate ? (
          <div className="rounded-md bg-sunken px-3 py-2" data-testid="usage-simulated">
            {simulated === null ? (
              <p className="text-xs text-muted">{t("usage.detail.simulating")}</p>
            ) : (
              <>
                <p className="text-xs text-muted">{t("usage.detail.simulatedLabel")}</p>
                <p className="text-lg font-semibold tabular-nums">{formatMoney(simulated.cost)}</p>
                <p className="text-xs text-muted">
                  {t("usage.detail.simulatedCoverage", { n: formatCount(simulated.requests) })}
                  {simulated.unavailable > 0 ? ` · ${t("usage.detail.simulatedUnavailable", { n: formatCount(simulated.unavailable) })}` : ""}
                </p>
              </>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
