import { FileText, FolderPlus, Link2, NotebookPen, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { ContentSourceKind } from "../../shared/enums.ts";
import { platformCapabilities } from "../../shared/platforms.ts";
import { usePatchContent } from "../api/queries.ts";
import { copyText } from "../ui/clipboard.ts";
import type { MenuAction, MenuEntry, MenuHit, MenuModel } from "../ui/context-menu.tsx";
import { useToast } from "../ui/toast.tsx";
import { CollectionMembershipDialog } from "./collection-membership-dialog.tsx";
import { DeleteContentDialog } from "./delete-content-dialog.tsx";
import { RenameContentDialog } from "./rename-content-dialog.tsx";

/** What the actions need to know of a Content; any listing's row can supply it. */
export interface ContentActionTarget {
  id: string;
  title?: string;
  pinnedAt?: number;
  /** The canonical source URL; local files have none. */
  sourceUrl?: string;
  /** Where the Content came from; decides whether a copied source link may stop opening. */
  sourceKind?: ContentSourceKind;
}

/**
 * The menus a Content offers its actions in: the right-click menu, the sidebar rows' 「⋯」
 * menu (`overflow`) and the library row's 「⋯」 menu (`row`), which holds every action of
 * the row, notes included.
 */
export type ContentActionSurface = "context" | "overflow" | "row";

/** One Content action and the menus that show it. */
export interface SurfacedAction extends MenuAction {
  surfaces: readonly ContentActionSurface[];
}

export interface ContentActionOptions {
  /** Where "open" goes; the Content's page by default. */
  openTo?: string;
}

export interface ContentActions {
  /** The rows one menu shows for a Content, in menu order. */
  entries: (surface: ContentActionSurface, content: ContentActionTarget, options?: ContentActionOptions) => MenuEntry[];
  /** The right-click menu of a Content row, for `useContextMenuTarget`. */
  menu: (content: ContentActionTarget, hit: MenuHit) => MenuModel;
  /** Opens the dialogs directly, for places with their own buttons. */
  rename: (contentId: string) => void;
  remove: (content: ContentActionTarget) => void;
  manageCollections: (contentId: string) => void;
  /** Rendered once by whoever called the hook; both menus share it. */
  dialogs: ReactNode;
}

/** A Content's page. */
export function contentPath(contentId: string): string {
  return `/contents/${contentId}`;
}

/** Builds a target from DTO fields, dropping absent ones. */
export function actionTarget(fields: {
  id: string;
  title?: string | undefined;
  pinnedAt?: number | undefined;
  sourceUrl?: string | undefined;
  sourceKind?: ContentSourceKind | undefined;
}): ContentActionTarget {
  return {
    id: fields.id,
    ...(fields.title === undefined ? {} : { title: fields.title }),
    ...(fields.pinnedAt === undefined ? {} : { pinnedAt: fields.pinnedAt }),
    ...(fields.sourceUrl === undefined ? {} : { sourceUrl: fields.sourceUrl }),
    ...(fields.sourceKind === undefined ? {} : { sourceKind: fields.sourceKind }),
  };
}

/**
 * Whether a copied source link of this origin may stop opening: some platforms put an expiring
 * access parameter in the link. Unknown origins get no warning.
 */
export function sourceLinkMayExpire(kind: ContentSourceKind | undefined): boolean {
  return kind !== undefined && kind !== "local" && platformCapabilities(kind).linkMayExpire;
}

/**
 * Where "open" goes for a right click: a link into this Content's own page (a search
 * excerpt's sentence, say) is followed as it stands, so "open" and the host's "open in new
 * tab" land in the same place. Any other link in the row (a collection chip) is about
 * another object, so "open" keeps meaning this Content.
 */
export function openTargetOf(hit: MenuHit, contentId: string): string | undefined {
  if (hit.anchor?.kind !== "internal") return undefined;
  const url = new URL(hit.anchor.href);
  return url.pathname === contentPath(contentId) ? `${url.pathname}${url.search}${url.hash}` : undefined;
}

/**
 * The one definition of what can be done to a Content from a row, so the
 * right-click menu and the 「⋯」 menu cannot drift apart. The hook is not bound to one
 * Content: a list calls it once and asks for each row's entries, and the dialogs it holds
 * remember which Content they act on.
 */
export function useContentActions(options: { onDeleted?: (contentId: string) => void } = {}): ContentActions {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const patch = usePatchContent();
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState<ContentActionTarget | undefined>(undefined);
  const [managing, setManaging] = useState<string | undefined>(undefined);
  const { onDeleted } = options;

  // A light confirmation once the link is on the clipboard (a failed copy only logs a warning).
  // Where the link may expire, the same toast says so on a second line.
  const copySourceUrl = async (sourceUrl: string, kind: ContentSourceKind | undefined): Promise<void> => {
    if (!(await copyText(sourceUrl))) return;
    toast.show({
      tone: "success",
      message: sourceLinkMayExpire(kind) ? (
        <>
          <span className="block">{t("common.menu.copiedSourceUrl")}</span>
          <span className="block text-note text-muted" data-testid="copied-source-url-expiry">
            {t("common.menu.sourceUrlMayExpire")}
          </span>
        </>
      ) : (
        t("common.menu.copiedSourceUrl")
      ),
    });
  };

  // Groups in menu order; deleting always comes last, set apart by a separator, in the same
  // colour as every other row: the confirmation dialog is where the warning lives.
  const groups = (content: ContentActionTarget, opts: ContentActionOptions): SurfacedAction[][] => {
    const pinned = content.pinnedAt !== undefined;
    const { sourceUrl } = content;
    return [
      [
        {
          id: "open",
          label: t("common.menu.open"),
          icon: <FileText size={14} aria-hidden="true" />,
          surfaces: ["context"],
          onSelect: () => void navigate(opts.openTo ?? contentPath(content.id)),
        },
        ...(sourceUrl === undefined
          ? []
          : [
              {
                id: "copy-source-url",
                label: t("common.menu.copySourceUrl"),
                icon: <Link2 size={14} aria-hidden="true" />,
                surfaces: ["context", "overflow", "row"] as const,
                onSelect: () => void copySourceUrl(sourceUrl, content.sourceKind),
              },
            ]),
      ],
      [
        { id: "rename", label: t("shell.sidebar.rename"), icon: <Pencil size={14} aria-hidden="true" />, surfaces: ["context", "overflow", "row"], onSelect: () => setRenaming(content.id) },
        {
          id: pinned ? "unpin" : "pin",
          label: pinned ? t("shell.sidebar.unpin") : t("shell.sidebar.pin"),
          icon: pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />,
          surfaces: ["context", "overflow", "row"],
          onSelect: () => patch.mutate({ contentId: content.id, patch: { pinned: !pinned } }),
        },
        {
          id: "membership",
          label: t("shell.sidebar.membership"),
          icon: <FolderPlus size={14} aria-hidden="true" />,
          surfaces: ["context", "overflow", "row"],
          onSelect: () => setManaging(content.id),
        },
        {
          id: "notes",
          label: t("library.notes.action"),
          icon: <NotebookPen size={14} aria-hidden="true" />,
          surfaces: ["row"],
          onSelect: () => void navigate(`/notes?contentId=${encodeURIComponent(content.id)}`),
        },
      ],
      [
        {
          id: "delete",
          label: t("shell.sidebar.delete"),
          icon: <Trash2 size={14} aria-hidden="true" />,
          surfaces: ["context", "overflow", "row"],
          onSelect: () => setDeleting(actionTarget({ id: content.id, title: content.title })),
        },
      ],
    ];
  };

  // The right-click menu separates all its groups; the small 「⋯」 menus keep their actions in
  // one plain list and set only deleting apart.
  const entries = (surface: ContentActionSurface, content: ContentActionTarget, opts: ContentActionOptions = {}): MenuEntry[] => {
    const out: MenuEntry[] = [];
    for (const group of groups(content, opts)) {
      const shown = group.filter((action) => action.surfaces.includes(surface));
      if (shown.length === 0) continue;
      if (out.length > 0 && (surface !== "overflow" || shown.some((action) => action.id === "delete"))) out.push("separator");
      out.push(...shown);
    }
    return out;
  };

  const menu = (content: ContentActionTarget, hit: MenuHit): MenuModel => {
    const openTo = openTargetOf(hit, content.id);
    return {
      kind: "object",
      href: contentPath(content.id),
      entries: entries("context", content, openTo === undefined ? {} : { openTo }),
    };
  };

  const dialogs = (
    <>
      <RenameContentDialog contentId={renaming} onOpenChange={(open) => (open ? undefined : setRenaming(undefined))} />
      <DeleteContentDialog
        content={deleting}
        onOpenChange={(open) => (open ? undefined : setDeleting(undefined))}
        {...(onDeleted === undefined || deleting === undefined ? {} : { onDeleted: () => onDeleted(deleting.id) })}
      />
      <CollectionMembershipDialog contentId={managing} onOpenChange={(open) => (open ? undefined : setManaging(undefined))} />
    </>
  );

  return { entries, menu, rename: setRenaming, remove: setDeleting, manageCollections: setManaging, dialogs };
}
