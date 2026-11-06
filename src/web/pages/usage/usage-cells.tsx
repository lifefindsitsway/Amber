import { useTranslation } from "react-i18next";
import type { UsageModalityUsage } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { costNote, otherCurrency, usageLines, type CostView } from "./usage-present.ts";

/**
 * Quantities of a row, one line per modality. A single modality reads as the number with its
 * unit beneath; two modalities keep the unit beside the number so both fit the row.
 */
export function UsageCell(props: { usage: UsageModalityUsage }) {
  const { t } = useTranslation();
  const lines = usageLines(props.usage, t);
  if (lines.length === 0) return <span className="text-muted">—</span>;
  const [only] = lines;
  if (lines.length === 1 && only !== undefined) {
    return (
      <div className="leading-tight" data-testid="usage-cell">
        <p className="truncate tabular-nums" title={only.main}>
          {only.main}
        </p>
        <p className="truncate text-xs text-muted" title={only.unit}>
          {only.unit}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 leading-tight" data-testid="usage-cell">
      {lines.map((line) => (
        <p key={line.modality} className="flex items-baseline justify-end gap-1">
          <span className="truncate tabular-nums" title={line.main}>
            {line.main}
          </span>
          <span className="shrink-0 text-xs text-muted">{line.unit}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * An amount in the display currency, or a dash with the reason it is missing. A request priced
 * in the other currency offers the switch instead of passing for unpriced.
 */
export function CostCell(props: { view: CostView; currency: PriceCurrency; onCurrency?: (currency: PriceCurrency) => void }) {
  const { t } = useTranslation();
  const { view } = props;
  const note = costNote(view, t);
  const switchable = view.kind === "other-currency" && props.onCurrency !== undefined;
  return (
    <div className="leading-tight" data-testid="usage-cost-cell">
      <p className="truncate tabular-nums" title={view.kind === "amount" ? view.text : undefined}>
        {view.kind === "amount" ? view.text : "—"}
      </p>
      {note === undefined ? null : switchable ? (
        <button
          type="button"
          className="max-w-full truncate rounded text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
          title={t("usage.cost.switchHint", { currency: t(`usage.currencyNames.${otherCurrency(props.currency)}`) })}
          onClick={(event) => {
            event.stopPropagation();
            props.onCurrency?.(otherCurrency(props.currency));
          }}
        >
          {note}
        </button>
      ) : (
        <p className="truncate text-xs text-muted" title={note}>
          {note}
        </p>
      )}
    </div>
  );
}
