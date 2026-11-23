import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button.tsx";

/**
 * A file chooser that opens only from its button. The native input stays hidden, so neither the
 * chosen name nor the rest of the row opens the dialog the way a full-width native input does.
 */
export function FilePicker(props: {
  accept: string;
  fileName: string | undefined;
  onFile: (file: File | undefined) => void;
  /** The id of the field's visible label; it is read together with the button. */
  labelledBy?: string;
  /** For pickers without a visible label. */
  label?: string;
  /** The ids of a hint or error explaining the field, read after the button. */
  describedBy?: string | undefined;
  /** Marks the field as failing validation, e.g. no file chosen yet. */
  invalid?: boolean | undefined;
  testId?: string;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const buttonId = useId();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <input
        ref={input}
        type="file"
        accept={props.accept}
        hidden
        tabIndex={-1}
        data-testid={props.testId}
        onChange={(event) => props.onFile(event.target.files?.[0] ?? undefined)}
      />
      <Button
        id={buttonId}
        {...(props.labelledBy === undefined ? {} : { "aria-labelledby": `${props.labelledBy} ${buttonId}` })}
        {...(props.label === undefined ? {} : { "aria-label": `${props.label} ${t("common.file.choose")}` })}
        aria-describedby={props.describedBy}
        aria-invalid={props.invalid === true ? true : undefined}
        onClick={() => input.current?.click()}
      >
        {t("common.file.choose")}
      </Button>
      <span className="min-w-0 truncate text-sm" title={props.fileName}>
        {props.fileName ?? t("common.file.none")}
      </span>
    </div>
  );
}
