import { Info } from "lucide-react";
import { Popover } from "radix-ui";
import { useTranslation } from "react-i18next";

const BASIS_ITEMS = ["estimate", "time", "cache", "assumptions", "inputMissing", "currency", "search"] as const;

/** The page header's 「统计口径」 button and the light popover it opens. */
export function UsageBasisButton() {
  const { t } = useTranslation();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={[
            "inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted outline-none",
            "hover:bg-sunken hover:text-ink focus-visible:ring-2 focus-visible:ring-accent",
          ].join(" ")}
          data-testid="usage-basis-button"
        >
          {t("usage.basis.button")}
          <Info size={14} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-[360px] max-w-[calc(100vw-16px)] rounded-md border border-line bg-surface p-4 text-sm shadow-lg"
          data-testid="usage-basis"
        >
          <h2 className="mb-2 text-sm font-medium">{t("usage.basis.title")}</h2>
          <ul className="flex flex-col gap-2 text-xs text-muted">
            {BASIS_ITEMS.map((item) => (
              <li key={item}>{t(`usage.basis.${item}`)}</li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
