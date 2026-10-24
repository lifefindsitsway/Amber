import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorView } from "../../components/error-view.tsx";
import { ApiError } from "../../api/client.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";

/** One block of a settings section: a heading, an optional explanation, then controls. */
export function SettingsBlock(props: { title?: ReactNode; intro?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="mb-6 rounded-lg border border-line bg-surface p-4">
      {props.title === undefined && props.actions === undefined ? null : (
        <div className="mb-3 flex items-center justify-between gap-3">
          {props.title === undefined ? <span /> : <h2 className="text-sm font-semibold">{props.title}</h2>}
          <div className="flex items-center gap-2">{props.actions}</div>
        </div>
      )}
      {props.intro === undefined ? null : <p className="mb-3 text-sm text-muted">{props.intro}</p>}
      {props.children}
    </section>
  );
}

/** Label + control + optional hint, stacked; `aside` sits on the label's line, e.g. a status. */
export function Field(props: { label: string; hint?: string | undefined; children: ReactNode; htmlFor?: string; aside?: ReactNode }) {
  const label = (
    <label className="mb-1 block text-xs font-medium text-muted" htmlFor={props.htmlFor}>
      {props.label}
    </label>
  );
  return (
    <div className="mb-3">
      {props.aside === undefined ? (
        label
      ) : (
        <div className="mb-1 flex items-center gap-3 [&>label]:mb-0">
          {label}
          {props.aside}
        </div>
      )}
      {props.children}
      {props.hint === undefined ? null : <p className="mt-1 text-xs text-muted">{props.hint}</p>}
    </div>
  );
}

export const INPUT_CLASS =
  "h-9 w-full rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent disabled:opacity-60";

/** Renders the AppError of a failed request; anything else is not shown. */
export function RequestError({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) {
    return null;
  }
  return (
    <div className="mt-2">
      <ErrorView error={error.error} />
    </div>
  );
}

/**
 * A button that asks before acting. Used for paid probes and deletions so nothing that
 * costs money or loses data runs on a single click.
 */
export function ConfirmButton(props: {
  label: string;
  message: string;
  onConfirm: () => void;
  variant?: "secondary" | "danger" | "primary" | "ghost";
  disabled?: boolean;
  size?: "sm" | "md";
  testId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={props.variant ?? "secondary"} size={props.size ?? "sm"} disabled={props.disabled} data-testid={props.testId} onClick={() => setOpen(true)}>
        {props.label}
      </Button>
      <Modal open={open} onOpenChange={setOpen} title={t("settings.common.confirmTitle")}>
        <p className="mb-4 text-sm">{props.message}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setOpen(false)}>{t("common.action.cancel")}</Button>
          <Button
            variant={props.variant === "danger" ? "danger" : "primary"}
            onClick={() => {
              setOpen(false);
              props.onConfirm();
            }}
          >
            {t("common.action.confirm")}
          </Button>
        </div>
      </Modal>
    </>
  );
}

/** Shows whether a write-only credential is stored, never the credential itself. */
export function CredentialStatus({ status }: { status: "missing" | "configured" | "unavailable" }) {
  const { t } = useTranslation();
  const tone = status === "configured" ? "text-ok" : status === "unavailable" ? "text-danger" : "text-muted";
  return <span className={`text-xs ${tone}`}>{t(`settings.common.credential.${status}`)}</span>;
}

/**
 * Write-only secret entry: the field is cleared as soon as the value is handed over and
 * nothing typed here is ever read back from the server.
 */
export function CredentialInput(props: { id: string; hasCredential: boolean; onSubmit: (value: string) => void; pending?: boolean }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(!props.hasCredential);
  if (!editing) {
    return (
      <Button size="sm" onClick={() => setEditing(true)}>
        {t("settings.common.credential.reset")}
      </Button>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed === "") {
          return;
        }
        setValue("");
        setEditing(false);
        props.onSubmit(trimmed);
      }}
    >
      <input
        id={props.id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className={`${INPUT_CLASS} min-w-0 flex-1`}
        value={value}
        placeholder={t("settings.common.credential.placeholder")}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" variant="primary" disabled={props.pending === true || value.trim() === ""}>
        {t("common.action.save")}
      </Button>
      {props.hasCredential ? (
        <Button onClick={() => { setValue(""); setEditing(false); }}>{t("common.action.cancel")}</Button>
      ) : null}
    </form>
  );
}

/** Parses a positive integer input; undefined for blank, NaN for anything invalid. */
export function positiveInt(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : Number.NaN;
}
