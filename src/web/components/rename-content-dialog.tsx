import { useQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DISPLAY_NAME_MAX_CHARS } from "../../shared/defaults.ts";
import { contentDetailDtoSchema, type ContentDetailDto } from "../../shared/dto/content.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, usePatchContent } from "../api/queries.ts";
import { Button } from "../ui/button.tsx";
import { Loading } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { FieldError } from "../ui/notice.tsx";
import { isComposingEnter, TextInput } from "../ui/text-field.tsx";
import { ErrorView } from "./error-view.tsx";

/**
 * The user's own title for one Content. The platform's or file's title is
 * kept, so a renamed Content can go back to it. Shared by the sidebar row menu, the
 * content page title and the library row.
 */
export function RenameContentDialog(props: { contentId: string | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={props.contentId !== undefined} onOpenChange={props.onOpenChange} title={t("library.rename.title")}>
      {props.contentId === undefined ? null : <RenameEditor contentId={props.contentId} onDone={() => props.onOpenChange(false)} />}
    </Modal>
  );
}

function RenameEditor(props: { contentId: string; onDone: () => void }) {
  const client = useApi();
  const { contentId } = props;
  // Same key and schema as the content page, so both read one cached detail.
  const content = useQuery({
    queryKey: queryKeys.content(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}`, contentDetailDtoSchema),
  });
  if (content.data === undefined) {
    return content.error instanceof ApiError ? <ErrorView error={content.error.error} /> : <Loading />;
  }
  return <RenameForm content={content.data} onDone={props.onDone} />;
}

function RenameForm(props: { content: ContentDetailDto; onDone: () => void }) {
  const { t } = useTranslation();
  const patch = usePatchContent();
  const { content } = props;
  const id = useId();
  const [title, setTitle] = useState(content.title ?? "");
  // The empty-title error waits for an edit: a Content that has no title yet is not an error on opening.
  const [edited, setEdited] = useState(false);
  const trimmed = title.trim();
  const empty = edited && trimmed === "";
  const save = (): void => {
    if (trimmed === "" || patch.isPending) return;
    if (trimmed === content.title) return props.onDone();
    patch.mutate({ contentId: content.id, patch: { title: trimmed } }, { onSuccess: props.onDone });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save();
  };
  const restoring = patch.isPending && patch.variables?.patch.title === null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="rename-content">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-title`} className="text-sm">
          {t("library.rename.label")}
        </label>
        <TextInput
          id={`${id}-title`}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setEdited(true);
          }}
          maxLength={DISPLAY_NAME_MAX_CHARS}
          autoFocus
          invalid={empty}
          aria-describedby={empty ? `${id}-error` : undefined}
          onKeyDown={(event) => {
            // Enter is handled by `onEnter`; the composing Enter only picks an input-method candidate.
            if (event.key === "Enter" && isComposingEnter(event)) event.preventDefault();
          }}
          onEnter={(event) => {
            event.preventDefault();
            save();
          }}
        />
        {empty ? (
          <FieldError id={`${id}-error`} testId="rename-content-error">
            {t("common.validation.required", { field: t("library.rename.label") })}
          </FieldError>
        ) : null}
      </div>
      {patch.error instanceof ApiError ? <ErrorView error={patch.error.error} /> : null}
      <div className="flex items-center justify-end gap-2">
        {content.customTitle === undefined ? null : (
          <Button
            className="mr-auto"
            variant="ghost"
            loading={restoring}
            disabled={patch.isPending}
            onClick={() => patch.mutate({ contentId: content.id, patch: { title: null } }, { onSuccess: props.onDone })}
          >
            {t("library.rename.restore")}
          </Button>
        )}
        <Button onClick={props.onDone}>{t("common.action.cancel")}</Button>
        <Button type="submit" variant="primary" loading={patch.isPending && !restoring} disabled={trimmed === "" || patch.isPending}>
          {t("common.action.save")}
        </Button>
      </div>
    </form>
  );
}
