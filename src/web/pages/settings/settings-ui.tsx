import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorView } from "../../components/error-view.tsx";
import type { AppError } from "../../../shared/errors.ts";
import { ApiError } from "../../api/client.ts";
import { Button, type ButtonSize } from "../../ui/button.tsx";
import { CONTROL_BASE, CONTROL_HEIGHT } from "../../ui/control.ts";
import { Modal } from "../../ui/modal.tsx";
import { FieldError, FieldHint, NOTE_TEXT_CLASS } from "../../ui/notice.tsx";
import { TextInput } from "../../ui/text-field.tsx";

/** One block of a settings section: a heading, an optional explanation, then controls. */
export function SettingsBlock(props: { title?: ReactNode; intro?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="mb-8 rounded-lg border border-line bg-surface p-4">
      {props.title === undefined && props.actions === undefined ? null : (
        <div className="mb-3 flex items-center justify-between gap-3">
          {props.title === undefined ? <span /> : <h2 className="text-sm font-semibold">{props.title}</h2>}
          <div className="flex items-center gap-2">{props.actions}</div>
        </div>
      )}
      {props.intro === undefined ? null : <p className={`mb-3 ${NOTE_TEXT_CLASS}`}>{props.intro}</p>}
      {props.children}
    </section>
  );
}

/**
 * Label + control + optional error and hint, stacked; `aside` sits on the label's line, e.g. a
 * status. The error sits right under the control, the hint under that; name them in the control's
 * `aria-describedby` through `fieldErrorId` / `fieldHintId` of the same `htmlFor`.
 */
export function Field(props: {
  label: string;
  hint?: string | undefined;
  /** What is wrong with the value; mark the control `aria-invalid` while it is set. */
  error?: ReactNode;
  errorTestId?: string;
  children: ReactNode;
  htmlFor?: string;
  aside?: ReactNode;
}) {
  const generated = useId();
  const controlId = props.htmlFor ?? generated;
  const label = (
    <label className="mb-1 block text-xs font-medium text-muted" htmlFor={props.htmlFor}>
      {props.label}
    </label>
  );
  return (
    <div className="mb-5">
      {props.aside === undefined ? (
        label
      ) : (
        <div className="mb-1 flex items-center gap-3 [&>label]:mb-0">
          {label}
          {props.aside}
        </div>
      )}
      {props.children}
      {props.error === undefined || props.error === null || props.error === false ? null : (
        <FieldError id={fieldErrorId(controlId)} className="mt-1.5" {...(props.errorTestId === undefined ? {} : { testId: props.errorTestId })}>
          {props.error}
        </FieldError>
      )}
      {props.hint === undefined ? null : (
        <FieldHint id={fieldHintId(controlId)} className="mt-1.5">
          {props.hint}
        </FieldHint>
      )}
    </div>
  );
}

/**
 * The id `Field` gives its hint when it labels a control by `htmlFor`, so the control can name
 * the hint in `aria-describedby` and screen readers read it with the field.
 */
export function fieldHintId(controlId: string): string {
  return `${controlId}-hint`;
}

/** The id `Field` gives its error, for the control's `aria-describedby`. */
export function fieldErrorId(controlId: string): string {
  return `${controlId}-error`;
}

/** The ids of the parts that describe a control, joined for `aria-describedby`; undefined when none. */
export function describedBy(...ids: ReadonlyArray<string | false | undefined>): string | undefined {
  const present = ids.filter((id): id is string => typeof id === "string" && id !== "");
  return present.length === 0 ? undefined : present.join(" ");
}

/**
 * The shared form-input look (see `TextInput`) as a class, for inputs that come wrapped in their
 * own component and so cannot be a `TextInput`: `PasswordInput`, `SuggestionInput`.
 */
export const INPUT_CLASS = `w-full px-2 ${CONTROL_BASE} ${CONTROL_HEIGHT.lg}`;

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

const TEST_RATE_LIMITED_CODES: ReadonlySet<string> = new Set(["llm_rate_limited", "llm_rate_limited.retry_after", "asr_failed.rate_limited"]);

/**
 * Like `RequestError`, for the result of a model "test connection". The stored wording of a
 * rate-limit error says the pipeline waited and retried and offers a step to rerun; a test
 * does neither (it fails on the first 429), so that text would be untrue here and is replaced
 * by advice to test again later. The upstream detail toggle is kept.
 */
export function TestConnectionError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!(error instanceof ApiError)) {
    return null;
  }
  const appError: AppError = error.error;
  if (!TEST_RATE_LIMITED_CODES.has(appError.code)) {
    return <RequestError error={error} />;
  }
  const retryAfterMs = appError.details?.["retryAfterMs"];
  const userMessage =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? t("settings.common.testRateLimitedIn", { seconds: Math.ceil(retryAfterMs / 1000) })
      : t("settings.common.testRateLimited");
  return (
    <div className="mt-2">
      <ErrorView error={{ ...appError, userMessage }} />
    </div>
  );
}

/**
 * A button that asks before acting. Used for paid probes and deletions so nothing that
 * costs money or loses data runs on a single click. The trigger only opens the dialog, so it
 * keeps the neutral look of `variant` even for a deletion: red is kept for the step that
 * actually destroys something. With `destructive` the dialog's final button is the filled
 * destructive one, otherwise the primary one; `confirmLabel` names what it does.
 */
export function ConfirmButton(props: {
  label: string;
  message: string;
  onConfirm: () => void;
  /** The trigger's look; secondary when absent. */
  variant?: "secondary" | "primary" | "ghost";
  /** The confirmed action deletes or discards data. */
  destructive?: boolean;
  /** The dialog's confirm button; "confirm" when absent. Say what happens, e.g. "delete". */
  confirmLabel?: string;
  disabled?: boolean;
  /** The confirmed action is under way: the button shows it and cannot be pressed again. */
  pending?: boolean;
  size?: ButtonSize;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={props.variant ?? "secondary"}
        size={props.size ?? "sm"}
        disabled={props.disabled}
        loading={props.pending === true}
        data-testid={props.testId}
        onClick={() => setOpen(true)}
      >
        {props.label}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t("settings.common.confirmTitle")}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t("common.action.cancel")}</Button>
            <Button
              variant={props.destructive === true ? "danger-solid" : "primary"}
              onClick={() => {
                setOpen(false);
                props.onConfirm();
              }}
            >
              {props.confirmLabel ?? t("common.action.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{props.message}</p>
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
export function CredentialInput(props: { id: string; hasCredential: boolean; onSubmit: (value: string) => void; pending?: boolean; describedBy?: string | undefined }) {
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
      <TextInput
        id={props.id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1"
        aria-describedby={props.describedBy}
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
