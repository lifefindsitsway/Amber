import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AppError } from "../../shared/errors.ts";
import { ApiError } from "../api/client.ts";
import { ErrorView } from "./error-view.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/modal.tsx";

/**
 * Explicit confirmation before a destructive or paid action. The action's failure stays
 * in the dialog as an AppError so the user sees why nothing happened. `danger` gives the confirm
 * button the filled destructive look, reserved for this final step.
 */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
  renderError?: (error: AppError) => ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | undefined>(undefined);
  const close = (open: boolean): void => {
    if (!open) {
      setError(undefined);
    }
    props.onOpenChange(open);
  };
  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await props.onConfirm();
      props.onOpenChange(false);
    } catch (caught) {
      setError(appErrorOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={props.open}
      onOpenChange={close}
      title={props.title}
      {...(props.description === undefined ? {} : { description: props.description })}
      footer={
        <>
          <Button onClick={() => close(false)}>{t("common.action.cancel")}</Button>
          <Button variant={props.danger === true ? "danger-solid" : "primary"} loading={busy} onClick={() => void confirm()}>
            {props.confirmLabel ?? t("common.action.confirm")}
          </Button>
        </>
      }
    >
      {error === undefined ? null : props.renderError?.(error) ?? <ErrorView error={error} />}
    </Modal>
  );
}

/** The AppError behind a failed call; anything else becomes a generic internal error. */
export function appErrorOf(error: unknown): AppError {
  if (error instanceof ApiError) {
    return error.error;
  }
  return { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" };
}
