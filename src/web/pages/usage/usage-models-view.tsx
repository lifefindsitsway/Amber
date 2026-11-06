import { useTranslation } from "react-i18next";
import type { UsageSummaryResponse } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { formatCount } from "../../format.ts";
import { CostCell, UsageCell } from "./usage-cells.tsx";
import { costView, modelLabel } from "./usage-present.ts";
import { seriesColor } from "./usage-trend.tsx";

type Model = UsageSummaryResponse["models"][number];

export const MODEL_SORTS = ["cost", "requests", "usage"] as const;
export type ModelSort = (typeof MODEL_SORTS)[number];

/** A model's weight under a sort; usage is compared within one modality because tokens and audio never add up. */
function weight(model: Model, sort: ModelSort): number {
  switch (sort) {
    case "cost":
      return Number(model.cost.amount?.amount ?? 0);
    case "requests":
      return model.requests;
    case "usage":
      return model.usage.llm === null ? Number(model.usage.asr?.audioMs ?? 0) : Number(model.usage.llm.input) + Number(model.usage.llm.output);
  }
}

/** Models in the order a sort asks for, and each one's share of the total it is compared within. */
export function rankModels(models: readonly Model[], sort: ModelSort): Array<{ model: Model; share: number }> {
  const comparedWith = (model: Model): Model[] => (sort === "usage" ? models.filter((other) => other.modality === model.modality) : [...models]);
  const ranked = [...models].sort((a, b) => {
    if (sort === "usage" && a.modality !== b.modality) return a.modality === "llm" ? -1 : 1;
    return weight(b, sort) - weight(a, sort);
  });
  return ranked.map((model) => {
    const total = comparedWith(model).reduce((sum, other) => sum + weight(other, sort), 0);
    return { model, share: total <= 0 ? 0 : weight(model, sort) / total };
  });
}

/** The by-model view: one row per profile and model, sortable; a row sets the model filter. */
export function UsageModelsView(props: {
  models: readonly Model[];
  sort: ModelSort;
  currency: PriceCurrency;
  selectedModelKey: string | undefined;
  onSelect: (modelKey: string) => void;
  onCurrency: (currency: PriceCurrency) => void;
  versionLabel: (profileKey: string, credentialVersion: string) => string;
}) {
  const { t } = useTranslation();
  const rows = rankModels(props.models, props.sort);
  return (
    <div className="overflow-x-auto" data-testid="usage-models">
      <table className="w-full min-w-[600px] table-fixed text-sm">
        <colgroup>
          <col />
          <col className="w-20" />
          <col className="w-36" />
          <col className="w-28" />
          <col className="w-[112px]" />
        </colgroup>
        <thead className="text-xs text-muted">
          <tr>
            <th className="px-4 py-2 text-left font-normal">{t("usage.models.model")}</th>
            <th className="px-3 py-2 text-right font-normal">{t("usage.models.requests")}</th>
            <th className="px-3 py-2 text-right font-normal">{t("usage.models.usage")}</th>
            <th className="px-3 py-2 text-right font-normal">{t("usage.models.cost")}</th>
            <th className="px-4 py-2 text-left font-normal">{t("usage.models.share")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ model, share }) => {
            const selected = model.modelKey === props.selectedModelKey;
            const label = modelLabel(model, t, model.profileDeleted);
            const versions = model.credentialVersions.map((version) => props.versionLabel(model.profileKey, version));
            return (
              <tr
                key={model.modelKey}
                className={`h-14 cursor-pointer border-t border-line hover:bg-sunken ${selected ? "bg-accent-soft" : ""}`}
                onClick={() => props.onSelect(model.modelKey)}
                data-testid="usage-model-row"
              >
                <td className="min-w-0 px-4">
                  <button
                    type="button"
                    className="block max-w-full truncate rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    aria-pressed={selected}
                    title={label}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onSelect(model.modelKey);
                    }}
                  >
                    {label}
                  </button>
                  {versions.length === 0 ? null : <p className="truncate text-xs text-muted" title={versions.join(" · ")}>
                      {versions.join(" · ")}
                    </p>}
                </td>
                <td className="px-3 text-right tabular-nums">{formatCount(model.requests)}</td>
                <td className="px-3 text-right">
                  <UsageCell usage={model.usage} />
                </td>
                <td className="px-3 text-right">
                  <CostCell view={costView(model.cost, props.currency)} currency={props.currency} onCurrency={props.onCurrency} />
                </td>
                <td className="px-4">
                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
                    role="img"
                    aria-label={t("usage.models.shareLabel", { percent: Math.round(share * 100) })}
                  >
                    <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: seriesColor(model.colorKey) }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
