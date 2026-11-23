import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { PASSWORD_MIN_LEN } from "../../shared/defaults.ts";
import { authMeDtoSchema, type AuthMeDto } from "../../shared/dto/system.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys } from "../api/queries.ts";
import { ErrorView } from "../components/error-view.tsx";
import { Button } from "../ui/button.tsx";
import { Callout } from "../ui/notice.tsx";
import { PasswordInput } from "../ui/password-input.tsx";
import { AUTH_FORM, AUTH_PASSWORD_INPUT, AuthField } from "./auth-card.tsx";

type PasswordFieldName = "current" | "next" | "confirm";

/**
 * `POST /api/auth/change-password`. The server revokes the user's other
 * sessions on success. When the caller already holds the current password (the login step
 * just verified it) the field is not asked again.
 */
export function ChangePasswordForm(props: { currentPassword?: string; submitLabel: string; onDone: (me: AuthMeDto) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const formId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  // A check made before sending, shown under the field it is about.
  const [problem, setProblem] = useState<{ field: PasswordFieldName; message: string } | undefined>(undefined);
  const change = useMutation({
    mutationFn: () =>
      client.post("/api/auth/change-password", authMeDtoSchema, {
        body: { currentPassword: props.currentPassword ?? current, newPassword: next },
        authRedirect: false,
      }),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.me, me);
      setCurrent("");
      setNext("");
      setConfirm("");
      props.onDone(me);
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(undefined);
    if ([...next].length < PASSWORD_MIN_LEN) return setProblem({ field: "next", message: t("auth.changePassword.tooShort", { min: PASSWORD_MIN_LEN }) });
    if (next !== confirm) return setProblem({ field: "confirm", message: t("auth.changePassword.mismatch") });
    change.mutate();
  };
  // The new password is checked above against the same rules the server applies, so an
  // `invalid_request` here means the current password did not match.
  const wrongCurrent = change.error instanceof ApiError && change.error.error.class === "invalid_request";
  const askCurrent = props.currentPassword === undefined;
  // A problem found on sending (here or by the server) shows while focus is still on the submit
  // button, and a field error is not a live region: moving focus to the field at fault (once it
  // is marked invalid and described by the error) is what makes a screen reader say why.
  useEffect(() => {
    if (problem !== undefined) document.getElementById(`${formId}-${problem.field}`)?.focus();
  }, [problem, formId]);
  const refusedField = wrongCurrent && askCurrent;
  useEffect(() => {
    if (refusedField) document.getElementById(`${formId}-current`)?.focus();
  }, [refusedField, change.error, formId]);
  const errorOf = (field: PasswordFieldName): { error: string } | Record<string, never> => {
    if (problem?.field === field) return { error: problem.message };
    return field === "current" && wrongCurrent ? { error: t("auth.changePassword.wrongCurrent") } : {};
  };
  const field = (name: PasswordFieldName, label: string, autoComplete: string, value: string, onChange: (value: string) => void) => (
    <AuthField
      id={`${formId}-${name}`}
      label={label}
      {...errorOf(name)}
      control={(control) => (
        <PasswordInput {...control} autoComplete={autoComplete} required value={value} onChange={(event) => onChange(event.target.value)} className={AUTH_PASSWORD_INPUT} />
      )}
    />
  );
  return (
    <form onSubmit={submit} className={AUTH_FORM} data-testid="change-password-form">
      {askCurrent ? field("current", t("auth.changePassword.currentPassword"), "current-password", current, setCurrent) : null}
      {field("next", t("auth.changePassword.newPassword"), "new-password", next, setNext)}
      {field("confirm", t("auth.changePassword.confirmPassword"), "new-password", confirm, setConfirm)}
      {change.error instanceof ApiError && !(wrongCurrent && askCurrent) ? (
        wrongCurrent ? (
          // The password the login step just verified was refused: there is no field to point at.
          <Callout tone="error" density="compact" announce="alert">
            {t("auth.changePassword.wrongCurrent")}
          </Callout>
        ) : (
          <ErrorView error={change.error.error} />
        )
      ) : null}
      <Button type="submit" variant="primary" loading={change.isPending}>
        {props.submitLabel}
      </Button>
    </form>
  );
}
