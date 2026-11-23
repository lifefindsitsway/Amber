import { DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FOCUS_RING } from "../ui/button.tsx";
import { MenuEntries } from "../ui/context-menu.tsx";
import type { ContentActions, ContentActionSurface, ContentActionTarget } from "./use-content-actions.tsx";

/** Shown on hover or focus only; touch screens, which cannot hover, always show it. */
const REVEALED_ON_HOVER = "size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100";
/** Always in place, the size of the library row's other icon buttons. */
const ALWAYS_SHOWN = "size-7 hover:text-ink";

/**
 * The 「⋯」 menu of a Content row: the actions of `useContentActions` for one surface
 * (`overflow` in the sidebar, `row` in the library). The row owns the hook and renders its
 * dialogs once, so this menu and the row's right-click menu share them. In the sidebar the
 * trigger shows on hover or focus; `alwaysShown` keeps it visible, as the library row does.
 */
export function ContentRowMenu(props: {
  actions: ContentActions;
  content: ContentActionTarget;
  label: string;
  className?: string;
  surface?: ContentActionSurface;
  alwaysShown?: boolean;
}) {
  const { t } = useTranslation();
  const alwaysShown = props.alwaysShown === true;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={t("shell.sidebar.recentMore", { title: props.label })}
        className={`flex items-center justify-center rounded text-muted hover:bg-line ${alwaysShown ? `${ALWAYS_SHOWN} ${FOCUS_RING}` : REVEALED_ON_HOVER} ${props.className ?? ""}`}
        data-testid="content-row-menu"
      >
        <MoreHorizontal size={alwaysShown ? 16 : 14} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side={alwaysShown ? "bottom" : "right"}
          align={alwaysShown ? "end" : "start"}
          sideOffset={4}
          className="z-50 min-w-36 rounded-md border border-line bg-surface p-1 text-sm shadow-lg"
        >
          <MenuEntries entries={props.actions.entries(props.surface ?? "overflow", props.content)} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
