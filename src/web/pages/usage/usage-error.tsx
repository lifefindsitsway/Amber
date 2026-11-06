import { useTranslation } from "react-i18next";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { Button } from "../../ui/button.tsx";

/** One line: what failed, and a way to try again. */
export function UsageError(props: { message: string; onRetry: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-3 text-sm ${props.compact === true ? "justify-center" : ""}`} role="alert">
      <span className="min-w-0 text-danger">{props.message}</span>
      <Button size="sm" onClick={props.onRetry}>
        {t("common.action.retry")}
      </Button>
    </div>
  );
}

/** A failed read of the page's main data, shown in place of the panels. */
export function UsageLoadError(props: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  const error = appErrorOf(props.error);
  const message = error.userMessage !== "" ? error.userMessage : t(`errors.${error.class}`);
  return (
    <div className="rounded-lg border border-line bg-panel px-5 py-3" data-testid="usage-error">
      <UsageError message={message} onRetry={props.onRetry} />
    </div>
  );
}
