import { FileDown, FolderOpen, ListPlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { AppError } from "../../../shared/errors.ts";
import { useSaveCollectionExport } from "../../export/export-data.ts";
import { appErrorOf } from "../confirm-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import type { MenuAction } from "../../ui/context-menu.tsx";
import { Modal } from "../../ui/modal.tsx";
import { ErrorView } from "../error-view.tsx";
import { BatchAddDialog } from "./batch-add-dialog.tsx";
import { DeleteCollectionDialog } from "./delete-collection-dialog.tsx";
import { EditCollectionDialog, type EditableCollection } from "./edit-collection-dialog.tsx";

/** Where an action is offered: the right-click menu, or the collection page's 「⋯」. */
export type CollectionSurface = "context" | "overflow";
export type CollectionActionId = "open" | "edit" | "batch-add" | "summarize" | "export" | "delete";
export interface CollectionAction extends MenuAction {
  id: CollectionActionId;
  surfaces: readonly CollectionSurface[];
}

export interface CollectionActionOptions {
  /** Edit in place (the collection page) instead of the edit dialog. */
  inlineEdit?: () => void;
  /** Re-run the rollup summary; only the collection page title offers it. */
  summarize?: () => void;
  summarizeDisabled?: boolean;
  /**
   * The actions belong to the collection's own page: "open" is left out, and an export
   * failure is returned as `exportError` for the page to show inline instead of a dialog.
   */
  ownPage?: boolean;
}

/**
 * The one definition of what can be done to a Collection. The
 * sidebar row, the collection list card and the collection page each pick the surface they
 * render; the dialogs the actions open are returned for the caller to mount once.
 */
export function useCollectionActions(
  collection: EditableCollection,
  options: CollectionActionOptions = {},
): {
  actions: CollectionAction[];
  menu: (surface: CollectionSurface) => CollectionAction[];
  action: (id: CollectionActionId) => CollectionAction | undefined;
  dialogs: ReactNode;
  exportError: AppError | undefined;
} {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [batchAdd, setBatchAdd] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const exportMarkdown = useSaveCollectionExport(collection.id);
  const ownPage = options.ownPage === true;
  const exportError = exportMarkdown.error === null ? undefined : appErrorOf(exportMarkdown.error);
  const { id, name } = collection;
  const { inlineEdit, summarize } = options;

  const actions: CollectionAction[] = [];
  if (!ownPage) {
    actions.push({
      id: "open",
      label: t("common.menu.open"),
      icon: <FolderOpen size={14} aria-hidden="true" />,
      surfaces: ["context"],
      onSelect: () => void navigate(`/collections/${id}`),
    });
  }
  actions.push(
    {
      id: "edit",
      label: t("library.collection.edit"),
      icon: <Pencil size={14} aria-hidden="true" />,
      surfaces: ["context"],
      onSelect: inlineEdit ?? (() => setEditing(true)),
    },
    {
      id: "batch-add",
      label: t("library.collection.batchAdd"),
      icon: <ListPlus size={14} aria-hidden="true" />,
      surfaces: ["context"],
      onSelect: () => setBatchAdd(true),
    },
  );
  if (summarize !== undefined) {
    actions.push({
      id: "summarize",
      label: t("library.collection.summarize"),
      icon: <RefreshCw size={14} aria-hidden="true" />,
      surfaces: ["context"],
      disabled: options.summarizeDisabled === true,
      onSelect: summarize,
    });
  }
  actions.push(
    {
      id: "export",
      label: t("library.collection.exportMarkdown"),
      icon: <FileDown size={14} aria-hidden="true" />,
      surfaces: ["context", "overflow"],
      onSelect: () => exportMarkdown.mutate({ backlinks: true }),
    },
    {
      id: "delete",
      label: t("library.collection.deleteCollection"),
      icon: <Trash2 size={14} aria-hidden="true" />,
      surfaces: ["context", "overflow"],
      onSelect: () => setDeleting(true),
    },
  );

  const dialogs = (
    <>
      <EditCollectionDialog collection={editing ? collection : undefined} onOpenChange={setEditing} />
      <BatchAddDialog open={batchAdd} onOpenChange={setBatchAdd} collectionId={id} />
      {/* The dialog leaves the collection's own page once it is gone. */}
      <DeleteCollectionDialog collection={deleting ? { id, name } : undefined} onOpenChange={setDeleting} />
      {ownPage ? null : (
        <Modal
          open={exportError !== undefined}
          onOpenChange={(open) => (open ? undefined : exportMarkdown.reset())}
          title={t("library.collection.exportFailed")}
          footer={<Button onClick={() => exportMarkdown.reset()}>{t("common.action.close")}</Button>}
        >
          {exportError === undefined ? null : <ErrorView error={exportError} />}
        </Modal>
      )}
    </>
  );

  return {
    actions,
    menu: (surface) => actions.filter((entry) => entry.surfaces.includes(surface)),
    action: (actionId) => actions.find((entry) => entry.id === actionId),
    dialogs,
    exportError: ownPage ? exportError : undefined,
  };
}
