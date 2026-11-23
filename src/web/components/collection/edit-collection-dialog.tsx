import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DISPLAY_NAME_MAX_CHARS } from "../../../shared/defaults.ts";
import type { CollectionPatchRequest } from "../../../shared/dto/collection.ts";
import { usePatchCollection } from "../../api/queries.ts";
import { appErrorOf } from "../confirm-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { TextArea, TextInput } from "../../ui/text-field.tsx";
import { ErrorView } from "../error-view.tsx";

export interface EditableCollection {
  id: string;
  name: string;
  description?: string;
}

/**
 * Edits a Collection's name and description from places with no page of their own (the
 * sidebar row, the collection list card); the collection page opens the same form in place.
 */
export function EditCollectionDialog(props: { collection: EditableCollection | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={props.collection !== undefined} onOpenChange={props.onOpenChange} title={t("library.collection.editTitle")}>
      {props.collection === undefined ? null : <CollectionEditForm collection={props.collection} onDone={() => props.onOpenChange(false)} />}
    </Modal>
  );
}

/**
 * The name and description fields. Only what changed is sent; an emptied description is
 * cleared with `null`. Enter in the name saves, Enter in the description is a new line.
 */
export function CollectionEditForm(props: { collection: EditableCollection; onDone: () => void; focus?: "name" | "description" }) {
  const { t } = useTranslation();
  const patch = usePatchCollection();
  const { collection } = props;
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? "");
  const trimmedName = name.trim();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (trimmedName === "") return;
    const trimmedDescription = description.trim();
    const changes: CollectionPatchRequest = {
      ...(trimmedName === collection.name ? {} : { name: trimmedName }),
      ...(trimmedDescription === (collection.description ?? "") ? {} : { description: trimmedDescription === "" ? null : trimmedDescription }),
    };
    if (Object.keys(changes).length === 0) return props.onDone();
    patch.mutate({ collectionId: collection.id, patch: changes }, { onSuccess: props.onDone });
  };
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onDone();
      }}
      className="flex flex-col gap-3"
      data-testid="edit-collection"
    >
      <label className="flex flex-col gap-1.5 text-sm">
        {t("library.collection.nameLabel")}
        <TextInput value={name} onChange={(event) => setName(event.target.value)} maxLength={DISPLAY_NAME_MAX_CHARS} autoFocus={props.focus !== "description"} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        {t("library.collections.descriptionLabel")}
        <TextArea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} autoFocus={props.focus === "description"} className="min-h-16" />
      </label>
      {patch.error === null ? null : <ErrorView error={appErrorOf(patch.error)} />}
      <div className="flex items-center justify-end gap-2">
        <Button onClick={props.onDone}>{t("common.action.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={trimmedName === "" || patch.isPending}>
          {t("common.action.save")}
        </Button>
      </div>
    </form>
  );
}
