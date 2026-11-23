import { useTranslation } from "react-i18next";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { Button } from "../../ui/button.tsx";
import { Callout, TextAction } from "../../ui/notice.tsx";

/**
 * A failed read inside a table row: one compact line with the reason and a way to try again, so
 * the row keeps about its usual height. Announced: it replaces the rows the user was waiting for.
 */
export function UsageError(props: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Callout tone="error" density="compact" announce="alert" className="mx-auto w-fit max-w-full">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="min-w-0">{props.message}</span>
        <TextAction onClick={props.onRetry}>{t("common.action.retry")}</TextAction>
      </span>
    </Callout>
  );
}

/** A failed read of the page's main data, shown in place of the panels. */
export function UsageLoadError(props: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div data-testid="usage-error">
      <ErrorView error={appErrorOf(props.error)}>
        <Button size="sm" onClick={props.onRetry}>
          {t("common.action.retry")}
        </Button>
      </ErrorView>
    </div>
  );
}
