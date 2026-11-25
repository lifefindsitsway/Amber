import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { COPY_FEEDBACK_MS } from "../../shared/defaults.ts";
import { useAutoDismiss } from "../use-auto-dismiss.ts";
import { copyText } from "./clipboard.ts";

const HIDDEN = { visibility: "hidden" } as const;

export type CopyFeedback = {
  /** A copy succeeded less than `COPY_FEEDBACK_MS` ago. */
  copied: boolean;
  /** Copies `text`; only a copy that happened shows as copied. Resolves whether it happened. */
  copy: (text: string) => Promise<boolean>;
};

/**
 * The brief "copied" state of a copy button: it shows for `COPY_FEEDBACK_MS`, then the button
 * reads "copy" again by itself. Every success bumps a counter that keys the wait, so copying again
 * while it shows starts the wait over; unmounting cancels it.
 */
export function useCopyFeedback(): CopyFeedback {
  const [shown, setShown] = useState<number | undefined>(undefined);
  useAutoDismiss(shown, () => setShown(undefined), COPY_FEEDBACK_MS);
  const flash = useCallback(() => setShown((previous) => (previous ?? 0) + 1), []);
  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const ok = await copyText(text);
      if (ok) flash();
      return ok;
    },
    [flash],
  );
  return { copied: shown !== undefined, copy };
}

/**
 * The icon and text of a copy button: a copy icon and `label`, or a check and "copied" while
 * `copied`. Both texts sit stacked in one grid cell and the other one is only made invisible
 * (`visibility: hidden`, set inline), so the slot is as wide as the wider of the two: the button
 * keeps its width and never pushes its neighbours. Invisible text is also out of the accessibility
 * tree, so the button is named by the text it shows.
 */
export function CopyLabel(props: { copied: boolean; label: string; iconSize?: number }) {
  const { t } = useTranslation();
  const size = props.iconSize ?? 14;
  return (
    <>
      {props.copied ? <Check size={size} className="text-ok" aria-hidden="true" /> : <Copy size={size} aria-hidden="true" />}
      <span className="inline-grid">
        <span className="col-start-1 row-start-1" style={props.copied ? HIDDEN : undefined}>
          {props.label}
        </span>
        <span className="col-start-1 row-start-1" style={props.copied ? undefined : HIDDEN}>
          {t("common.action.copied")}
        </span>
      </span>
    </>
  );
}
