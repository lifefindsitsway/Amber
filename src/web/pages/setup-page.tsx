import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { PASSWORD_MIN_LEN } from "../../shared/defaults.ts";
import { authMeDtoSchema } from "../../shared/dto/system.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys } from "../api/queries.ts";
import { AUTH_FORM, AUTH_PASSWORD_INPUT, AuthCard, AuthField } from "../auth/auth-card.tsx";
import { takeNext } from "../auth/next-path.ts";
import { ErrorView } from "../components/error-view.tsx";
import { Button } from "../ui/button.tsx";
import { Callout, TEXT_ACTION_CLASS } from "../ui/notice.tsx";
import { PasswordInput } from "../ui/password-input.tsx";
import { TextInput } from "../ui/text-field.tsx";

/** The request header that carries the one-time setup token; never the URL. */
const SETUP_TOKEN_HEADER = "x-amber-setup-token";

/**
 * `/setup`: creates the first administrator with the one-time token
 * printed on the server console. Nothing is requested on load — the page only learns
 * whether the token is valid or the instance already initialized when the form is sent.
 */
export function SetupPage() {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const formId = useId();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  // A check made before sending, shown under the field it is about.
  const [problem, setProblem] = useState<{ field: "password" | "confirm"; message: string } | undefined>(undefined);
  const tokenInput = useRef<HTMLInputElement>(null);
  const setup = useMutation({
    mutationFn: () =>
      client.post("/api/setup", authMeDtoSchema, {
        body: { username, password, ...(displayName.trim() === "" ? {} : { displayName: displayName.trim() }) },
        headers: { [SETUP_TOKEN_HEADER]: token.trim() },
        authRedirect: false,
      }),
    onSuccess: (me) => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
      queryClient.setQueryData(queryKeys.me, me);
      void navigate(me.mustChangePassword ? "/login" : takeNext(), { replace: true });
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(undefined);
    if ([...password].length < PASSWORD_MIN_LEN) return setProblem({ field: "password", message: t("admin.users.passwordTooShort", { min: PASSWORD_MIN_LEN }) });
    if (password !== confirm) return setProblem({ field: "confirm", message: t("auth.changePassword.mismatch") });
    setup.mutate();
  };
  const failure = setup.error instanceof ApiError ? setup.error : undefined;
  // A refused token is the token field's problem; it stays until the next attempt.
  const badToken = failure?.status === 401;
  // A problem found on sending shows while focus is still on the submit button, and a field
  // error is not a live region: moving focus to the field at fault (once it is marked invalid
  // and described by the error) is what makes a screen reader say why nothing was created.
  useEffect(() => {
    if (problem !== undefined) document.getElementById(`${formId}-${problem.field}`)?.focus();
  }, [problem, formId]);
  useEffect(() => {
    if (badToken) tokenInput.current?.focus();
  }, [badToken, setup.error]);
  const fieldError = (field: "password" | "confirm"): { error: string } | Record<string, never> => (problem?.field === field ? { error: problem.message } : {});
  return (
    <AuthCard
      title={t("auth.setup.title")}
      intro={t("auth.setup.intro")}
      footer={
        <Link to="/login" className={TEXT_ACTION_CLASS}>
          {t("auth.setup.backToLogin")}
        </Link>
      }
    >
      <form onSubmit={submit} className={AUTH_FORM} data-testid="setup-form">
        <AuthField
          id={`${formId}-token`}
          label={t("auth.setup.token")}
          hint={t("auth.setup.tokenHint")}
          {...(badToken ? { error: t("auth.setup.badToken") } : {})}
          control={(field) => (
            <TextInput {...field} ref={tokenInput} autoComplete="off" spellCheck={false} required value={token} onChange={(event) => setToken(event.target.value)} className="w-full font-mono" />
          )}
        />
        <AuthField
          id={`${formId}-username`}
          label={t("auth.setup.username")}
          hint={t("auth.setup.usernameHint")}
          control={(field) => <TextInput {...field} autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} className="w-full" />}
        />
        <AuthField
          id={`${formId}-password`}
          label={t("auth.setup.password")}
          {...fieldError("password")}
          control={(field) => (
            <PasswordInput {...field} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={AUTH_PASSWORD_INPUT} />
          )}
        />
        <AuthField
          id={`${formId}-confirm`}
          label={t("auth.setup.confirmPassword")}
          {...fieldError("confirm")}
          control={(field) => (
            <PasswordInput {...field} autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} className={AUTH_PASSWORD_INPUT} />
          )}
        />
        <AuthField
          id={`${formId}-display-name`}
          label={t("auth.setup.displayName")}
          control={(field) => <TextInput {...field} value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="w-full" />}
        />
        {failure === undefined || badToken ? null : failure.status === 409 ? (
          <Callout
            tone="info"
            density="compact"
            announce="status"
            actions={
              <Link to="/login" className={`font-medium ${TEXT_ACTION_CLASS}`}>
                {t("auth.setup.goLogin")}
              </Link>
            }
          >
            {t("auth.setup.alreadyInitialized")}
          </Callout>
        ) : (
          <ErrorView error={failure.error} />
        )}
        <Button type="submit" variant="primary" loading={setup.isPending}>
          {t("auth.setup.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
