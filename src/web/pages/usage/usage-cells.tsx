import { Fragment, useState, type FocusEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { UsageModalityUsage } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { TEXT_ACTION_CLASS } from "../../ui/notice.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";
import {
  breakdownSentence,
  costNote,
  credentialVersionHint,
  otherCurrency,
  usageBreakdown,
  usageLines,
  versionTagText,
  type BreakdownRow,
  type CostView,
  type CredentialVersionLabel,
} from "./usage-present.ts";

/**
 * Quantities of a row, one line per modality. A single modality reads as the number with its
 * unit beneath; two modalities keep the unit beside the number so both fit the row. The figures
 * are compact; `exact` adds the exact breakdown for assistive technology, in place of the
 * compact figures, for a row that has no control to carry it as a description.
 */
export function UsageCell(props: { usage: UsageModalityUsage; exact?: boolean }) {
  const { t } = useTranslation();
  const lines = usageLines(props.usage, t);
  if (lines.length === 0) return <span className="text-muted">—</span>;
  const exact = props.exact === true ? breakdownSentence(usageBreakdown(props.usage, t), t) : undefined;
  const hidden = exact === undefined ? {} : { "aria-hidden": true };
  const [only] = lines;
  const visible =
    lines.length === 1 && only !== undefined ? (
      <div className="leading-tight" {...hidden}>
        <p className="truncate tabular-nums">{only.main}</p>
        <p className="truncate text-xs text-muted">{only.unit}</p>
      </div>
    ) : (
      <div className="flex flex-col gap-0.5 leading-tight" {...hidden}>
        {lines.map((line) => (
          <p key={line.modality} className="flex items-baseline justify-end gap-1">
            <span className="truncate tabular-nums">{line.main}</span>
            <span className="shrink-0 text-xs text-muted">{line.unit}</span>
          </p>
        ))}
      </div>
    );
  return (
    // `relative` keeps the visually hidden text inside the cell; positioned against the page it
    // would stretch the document and let the whole app scroll.
    <div className="relative" data-testid="usage-cell">
      {visible}
      {exact === undefined ? null : <span className="sr-only">{exact}</span>}
    </div>
  );
}

const DEPTH_CLASS: Readonly<Record<BreakdownRow["depth"], string>> = { 0: "", 1: "pl-3 text-muted", 2: "pl-6 text-muted" };

/**
 * A row's recorded usage as aligned columns: name, exact value, unit. Parts already included in
 * the line above are indented beneath it; the transcription section starts with a little air.
 */
export function UsageBreakdown(props: { usage: UsageModalityUsage }) {
  const { t } = useTranslation();
  const rows = usageBreakdown(props.usage, t);
  return (
    <div data-testid="usage-breakdown">
      <p className="mb-1.5 font-medium">{t("usage.breakdown.title")}</p>
      <div className="grid grid-cols-[auto_auto_auto] items-baseline gap-x-2 gap-y-0.5 tabular-nums">
        {rows.map((row, index) => {
          const gap = row.key === "audio" && index > 0 ? "pt-1.5" : "";
          const tone = row.depth === 0 ? "" : "text-muted";
          return (
            <Fragment key={row.key}>
              <span className={`${DEPTH_CLASS[row.depth]} ${gap} whitespace-nowrap`} data-testid={`usage-breakdown-${row.key}`}>
                {row.label}
              </span>
              <span className={`${tone} ${gap} text-right whitespace-nowrap`}>{row.value}</span>
              <span className={`${gap} text-muted`}>{`${row.unit}${row.note}`}</span>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Whether a control's focus came from the keyboard. A mouse click also focuses a button, and
 * the breakdown should then not pop up over the row the user is clicking.
 */
function keyboardFocus(event: FocusEvent<HTMLElement>): boolean {
  try {
    return event.currentTarget.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * The open state of a row's breakdown tooltip: hovering its usage cell, or keyboard focus on the
 * row's own control. Closing it either way (leaving, Escape, a click elsewhere) clears both.
 */
export function useBreakdownOpen(): { open: boolean; onOpenChange: (open: boolean) => void; onFocus: (event: FocusEvent<HTMLElement>) => void; onBlur: () => void } {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return {
    open: hover || focus,
    onOpenChange: (open) => {
      setHover(open);
      if (!open) setFocus(false);
    },
    onFocus: (event) => setFocus(keyboardFocus(event)),
    onBlur: () => setFocus(false),
  };
}

/**
 * Hovering `children` (a usage cell) shows the breakdown. `open` lets the row also show it while
 * its own control has keyboard focus, so a keyboard user gets it without an extra stop.
 */
export function UsageBreakdownTooltip(props: { usage: UsageModalityUsage; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactElement }) {
  if (props.usage.llm === null && props.usage.asr === null) return props.children;
  return (
    <Tooltip
      content={<UsageBreakdown usage={props.usage} />}
      side="left"
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange })}
      testId="usage-breakdown-tooltip"
    >
      {props.children}
    </Tooltip>
  );
}

/**
 * Which key a row's calls used, for a profile with more than one in the range: the key prefix and the day it was saved.
 * Hovering says when each key was saved; nothing of a key itself is ever shown.
 */
export function VersionTag(props: { labels: readonly CredentialVersionLabel[]; className?: string }) {
  const { t } = useTranslation();
  if (props.labels.length === 0) return null;
  const [only] = props.labels;
  const hints =
    props.labels.length === 1 && only !== undefined
      ? [credentialVersionHint(only, t)]
      : props.labels.map((label) => t("usage.names.versionHintLine", { label: label.text, hint: credentialVersionHint(label, t) }));
  return (
    <Tooltip
      content={
        <div className="flex max-w-xs flex-col gap-1" data-testid="usage-version-hint">
          {hints.map((hint) => (
            <p key={hint}>{hint}</p>
          ))}
        </div>
      }
      testId="usage-version-tooltip"
    >
      <span className={`truncate ${props.className ?? ""}`} data-testid="usage-version-tag">
        {versionTagText(props.labels, t)}
      </span>
    </Tooltip>
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
          className={`max-w-full truncate text-xs ${TEXT_ACTION_CLASS}`}
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
