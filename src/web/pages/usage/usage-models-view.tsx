import { useTranslation } from "react-i18next";
import type { UsageSummaryResponse } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { formatCount } from "../../format.ts";
import { CostCell, UsageBreakdownTooltip, UsageCell, useBreakdownOpen, VersionTag } from "./usage-cells.tsx";
import { UsageModelMark } from "./usage-marks.tsx";
import { breakdownDescription, costView, modelLabel, rowVersionLabels, usageBreakdown, type CredentialVersionLabels } from "./usage-present.ts";
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
  versionLabels: CredentialVersionLabels;
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
          {rows.map(({ model, share }) => (
            <ModelRow
              key={model.modelKey}
              model={model}
              share={share}
              selected={model.modelKey === props.selectedModelKey}
              currency={props.currency}
              onSelect={props.onSelect}
              onCurrency={props.onCurrency}
              versionLabels={props.versionLabels}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One model. The usage breakdown shows on hovering its usage, or while the model button has
 * keyboard focus (the row's one control, so no extra stop); the button carries it as its description.
 */
function ModelRow(props: {
  model: Model;
  share: number;
  selected: boolean;
  currency: PriceCurrency;
  onSelect: (modelKey: string) => void;
  onCurrency: (currency: PriceCurrency) => void;
  versionLabels: CredentialVersionLabels;
}) {
  const { t } = useTranslation();
  const { model, share, selected } = props;
  const hint = useBreakdownOpen();
  const label = modelLabel(model, t, model.profileDeleted);
  const versions = rowVersionLabels(props.versionLabels, model.profileKey, model.credentialVersions);
  const breakdown = usageBreakdown(model.usage, t);
  const descriptionId = `usage-model-usage-${model.modelKey}`;
  return (
    <tr
      className={`h-14 cursor-pointer border-t border-line hover:bg-sunken ${selected ? "bg-accent-soft" : ""}`}
      onClick={() => props.onSelect(model.modelKey)}
      data-testid="usage-model-row"
    >
      <td className="min-w-0 px-4">
        <button
          type="button"
          className="flex max-w-full items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-pressed={selected}
          title={label}
          {...(breakdown.length === 0 ? {} : { "aria-describedby": descriptionId })}
          onFocus={hint.onFocus}
          onBlur={hint.onBlur}
          onClick={(event) => {
            event.stopPropagation();
            props.onSelect(model.modelKey);
          }}
        >
          <UsageModelMark modelKey={model.modelKey} modelId={model.modelId} size={16} />
          <span className="min-w-0 truncate">{label}</span>
        </button>
        {breakdown.length === 0 ? null : (
          <span id={descriptionId} hidden>
            {breakdownDescription(breakdown, t)}
          </span>
        )}
        {versions.length === 0 ? null : (
          <p className="flex min-w-0 pl-[22px] text-xs text-muted">
            <VersionTag labels={versions} />
          </p>
        )}
      </td>
      <td className="px-3 text-right tabular-nums">{formatCount(model.requests)}</td>
      <td className="px-3 text-right">
        <UsageBreakdownTooltip
          usage={model.usage}
          open={hint.open}
          onOpenChange={hint.onOpenChange}
        >
          <div data-testid="usage-model-usage">
            <UsageCell usage={model.usage} />
          </div>
        </UsageBreakdownTooltip>
      </td>
      <td className="px-3 text-right">
        <CostCell view={costView(model.cost, props.currency)} currency={props.currency} onCurrency={props.onCurrency} />
      </td>
      <td className="px-4">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="img" aria-label={t("usage.models.shareLabel", { percent: Math.round(share * 100) })}>
          <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: seriesColor(model.colorKey) }} />
        </div>
      </td>
    </tr>
  );
}
