import type { ReactNode } from "react";
import { CONTROL_BASE, CONTROL_HEIGHT } from "../ui/control.ts";
import { FieldError, FieldHint } from "../ui/notice.tsx";

/** The centered card of the pages outside the app shell (login, setup). `centerTitle` is for the login card, whose title names the product rather than a step. */
export function AuthCard(props: { title: string; intro?: string; children: ReactNode; footer?: ReactNode; centerTitle?: boolean }) {
  return (
    <div className="flex min-h-full items-start justify-center bg-sunken px-4 py-[12vh]">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-sm">
        <div className="flex flex-col gap-1.5">
          <h1 className={`text-xl font-semibold ${props.centerTitle === true ? "text-center" : ""}`}>{props.title}</h1>
          {props.intro === undefined ? null : <p className="text-sm text-muted">{props.intro}</p>}
        </div>
        <div className="mt-6">{props.children}</div>
        {props.footer === undefined ? null : <div className="mt-6 border-t border-line pt-4 text-sm">{props.footer}</div>}
      </div>
    </div>
  );
}

/**
 * The look of a password field on these forms, the same as `TextInput` at form height; the
 * password input appends its own right padding for the show / hide toggle.
 */
export const AUTH_PASSWORD_INPUT = `w-full px-2 ${CONTROL_BASE} ${CONTROL_HEIGHT.lg}`;

/** Fields of an auth form: 20 px apart, the submit button and any form-wide notice in the same column. */
export const AUTH_FORM = "flex flex-col gap-5";

/** What a control needs to be named and described by its field. */
export interface AuthFieldControl {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * A labelled control with its optional hint and error under it, 6 px apart. The control is
 * rendered by the caller with the ids this field hands it, so a screen reader reads the hint and
 * the error with the control, and the error marks the control invalid. The error sits right under
 * the control, above the hint, where the eye is when the form is sent.
 */
export function AuthField(props: { id: string; label: string; hint?: string; error?: string; control: (control: AuthFieldControl) => ReactNode }) {
  const hintId = `${props.id}-hint`;
  const errorId = `${props.id}-error`;
  const described = [props.hint === undefined ? undefined : hintId, props.error === undefined ? undefined : errorId].filter((id): id is string => id !== undefined);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-sm">
        {props.label}
      </label>
      {props.control({
        id: props.id,
        ...(described.length === 0 ? {} : { "aria-describedby": described.join(" ") }),
        ...(props.error === undefined ? {} : { "aria-invalid": true as const }),
      })}
      {props.error === undefined ? null : <FieldError id={errorId}>{props.error}</FieldError>}
      {props.hint === undefined ? null : <FieldHint id={hintId}>{props.hint}</FieldHint>}
    </div>
  );
}
