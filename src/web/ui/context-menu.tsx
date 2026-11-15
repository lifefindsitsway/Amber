import { DropdownMenu } from "radix-ui";
import { Copy, ExternalLink, Link as LinkIcon, SquareArrowOutUpRight } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { copyText } from "./clipboard.ts";
import { selectionSourceFor, type RegionSelection } from "./selection-source.ts";

/**
 * One clickable menu row. `onSelect` must only use data captured when the menu was built.
 * Rows carry no colour of their own: destructive actions warn in their confirmation dialog.
 */
export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}
export type MenuEntry = MenuAction | "separator";

/** How a right-clicked link relates to the app: decides which link rows the menu offers. */
export type LinkKind = "internal" | "external" | "mailto" | "other";

/** What the right click landed on, collected before any object is asked. */
export interface MenuHit {
  target: Element;
  /**
   * The selection, when the click fell inside it: `text` is what "copy selection" takes.
   * `region` is the reading of a region that answers for the selection itself, `null` when such
   * a region has nothing to work on, and absent when none answers (the page is read instead).
   */
  selection?: { text: string; region?: RegionSelection | null };
  /** The nearest link around the target, with its resolved (exact) href. */
  anchor?: { href: string; kind: LinkKind; element: HTMLAnchorElement };
}

/**
 * The menu an object offers for a hit. `text` objects (sentences, messages, summaries) are
 * skipped for touch input so a long press keeps selecting text; `href` is the object's own
 * page, offered as "open in new tab" on the web when the click was not on a link.
 * `selectionEntries` go right after "copy selection" (e.g. "explain selection").
 */
export interface MenuModel {
  kind: "object" | "text";
  href?: string;
  selectionEntries?: MenuAction[];
  entries: MenuEntry[];
}
export type MenuProvider = (hit: MenuHit) => MenuModel | undefined;

type ProviderRef = RefObject<MenuProvider>;
const RegistryContext = createContext<WeakMap<Element, ProviderRef> | undefined>(undefined);

/**
 * Registers the element the returned callback ref is attached to as a context-menu object.
 * The provider is asked at right-click time and may return undefined (e.g. a list whose
 * click fell between sentences) to let an outer object or the default behaviour apply.
 * Without a `ContextMenuHost` above, nothing is registered.
 */
export function useContextMenuTarget<T extends Element = HTMLElement>(provide: MenuProvider): (element: T | null) => (() => void) | undefined {
  const registry = useContext(RegistryContext);
  const latest = useRef(provide);
  latest.current = provide;
  return useCallback(
    (element: T | null) => {
      if (registry === undefined || element === null) return undefined;
      registry.set(element, latest);
      return () => {
        if (registry.get(element) === latest) registry.delete(element);
      };
    },
    [registry],
  );
}

/** Editable regions by attribute, for environments without `isContentEditable` (jsdom). */
const EDITABLE_REGION = ['[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]'].join(",");
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** Controls whose own (system) edit menu stays: text fields and editable regions only. */
export function isTextEditableTarget(target: Element): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLElement && target.isContentEditable === true) return true;
  return target.closest(EDITABLE_REGION) !== null;
}

/**
 * The selection when the point lies inside the current selection. Only the point-to-caret APIs
 * decide; without them the selection is not used rather than guessed from element containment
 * (which misreads a partly selected element). A region answering for the selection supplies the
 * text: the page may hold only part of what is selected.
 */
export function selectionAt(x: number, y: number, doc: Document = document): MenuHit["selection"] {
  const selection = doc.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const point = caretPoint(doc, x, y);
  if (point === undefined || !pointInSelection(selection, point)) return undefined;
  const region = selectionSourceFor(selection);
  const read = region?.source.read();
  if (read !== undefined) return { text: read.menuCopyText, region: read };
  const text = selection.toString();
  if (text.trim() === "") return undefined;
  return region === undefined ? { text } : { text, region: null };
}

/**
 * The selection a region keeps, for a menu asked for at a point outside the window. That is a
 * menu opened from the keyboard: the browser places it at the start of the selection, which a
 * selection running across many screens has left behind. The region then stands for the place.
 */
function keptSelection(doc: Document): { selection: NonNullable<MenuHit["selection"]>; element: Element } | undefined {
  const region = selectionSourceFor(doc.getSelection());
  const read = region?.source.read();
  return region === undefined || read === undefined ? undefined : { selection: { text: read.menuCopyText, region: read }, element: region.element };
}

function pointInSelection(selection: Selection, point: { node: Node; offset: number }): boolean {
  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).isPointInRange(point.node, point.offset)) return true;
    } catch {
      // The point lies in another document or a doctype: not inside.
    }
  }
  return false;
}

interface CaretDocument {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

function caretPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | undefined {
  const caret = doc as unknown as CaretDocument;
  if (typeof caret.caretPositionFromPoint === "function") {
    const position = caret.caretPositionFromPoint.call(doc, x, y);
    return position === null ? undefined : { node: position.offsetNode, offset: position.offset };
  }
  if (typeof caret.caretRangeFromPoint === "function") {
    const range = caret.caretRangeFromPoint.call(doc, x, y);
    return range === null ? undefined : { node: range.startContainer, offset: range.startOffset };
  }
  return undefined;
}

/**
 * The nearest link and its kind. "external" follows the desktop rule for leaving the app
 * (`externalHref` in desktop-integration): another origin or `target="_blank"`.
 */
export function linkAt(target: Element, appOrigin: string): MenuHit["anchor"] {
  const element = target.closest("a[href]");
  if (!(element instanceof HTMLAnchorElement)) return undefined;
  let url: URL;
  try {
    url = new URL(element.getAttribute("href") ?? "", appOrigin);
  } catch {
    return undefined;
  }
  let kind: LinkKind = "other";
  if (url.protocol === "mailto:") kind = "mailto";
  else if (url.protocol === "http:" || url.protocol === "https:") kind = element.target === "_blank" || url.origin !== appOrigin ? "external" : "internal";
  return { href: url.href, kind, element };
}

/**
 * Where the menu is portaled: in fullscreen only the fullscreen element is painted, so the
 * menu goes inside it; otherwise (and for a fullscreen iframe, which cannot hold it) the body.
 */
function fullscreenHost(): HTMLElement | undefined {
  const element = document.fullscreenElement;
  return element instanceof HTMLElement && !(element instanceof HTMLIFrameElement) ? element : undefined;
}

/** Innermost registered object that answers for this hit. */
function modelAt(registry: WeakMap<Element, ProviderRef>, hit: MenuHit, touch: boolean): MenuModel | undefined {
  for (let node: Element | null = hit.target; node !== null; node = node.parentElement) {
    const provider = registry.get(node);
    if (provider === undefined) continue;
    const model = provider.current(hit);
    if (model === undefined || (touch && model.kind === "text")) continue;
    return model;
  }
  return undefined;
}

type Translate = (key: string) => string;

/** Selection rows, then link rows, then the object's rows; separators only between groups. */
export function assembleMenu(hit: MenuHit, model: MenuModel | undefined, desktop: boolean, t: Translate): MenuEntry[] {
  const groups: MenuEntry[][] = [];
  if (hit.selection !== undefined) {
    const text = hit.selection.text;
    groups.push([{ id: "copy-selection", label: t("common.menu.copySelection"), icon: <Copy size={14} aria-hidden="true" />, onSelect: () => void copyText(text) }, ...(model?.selectionEntries ?? [])]);
  }
  const links: MenuAction[] = [];
  const newTab = (href: string): MenuAction => ({
    id: "open-new-tab",
    label: t("common.menu.openInNewTab"),
    icon: <SquareArrowOutUpRight size={14} aria-hidden="true" />,
    onSelect: () => void window.open(href, "_blank", "noopener"),
  });
  if (hit.anchor !== undefined) {
    const { href, kind } = hit.anchor;
    if (kind === "internal" && !desktop) links.push(newTab(href));
    if (kind === "external") {
      links.push(
        desktop
          ? {
              id: "open-in-browser",
              label: t("common.menu.openInBrowser"),
              icon: <ExternalLink size={14} aria-hidden="true" />,
              onSelect: () => void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href)).catch(() => undefined),
            }
          : newTab(href),
      );
    }
    // The client has one window, and an in-app address means nothing outside it; the anchor
    // still steers the object's "open" (see `openTargetOf`).
    if (!(kind === "internal" && desktop)) {
      links.push({ id: "copy-link-address", label: t("common.menu.copyLinkAddress"), icon: <LinkIcon size={14} aria-hidden="true" />, onSelect: () => void copyText(href) });
    }
  }
  let own: MenuEntry[] = model?.entries ?? [];
  if (hit.anchor === undefined && model?.href !== undefined && !desktop) {
    // The object's own page: next to its "open" row when it has one, else on its own.
    const openAt = own.findIndex((entry) => entry !== "separator" && entry.id === "open");
    if (openAt >= 0) own = [...own.slice(0, openAt + 1), newTab(model.href), ...own.slice(openAt + 1)];
    else links.push(newTab(model.href));
  }
  groups.push(links);
  groups.push(own);
  const entries: MenuEntry[] = [];
  for (const group of groups) {
    const rows = tidy(group);
    if (rows.length === 0) continue;
    if (entries.length > 0) entries.push("separator");
    entries.push(...rows);
  }
  return entries;
}

/** Drops leading, trailing and doubled separators. */
function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry === "separator" && (out.length === 0 || out.at(-1) === "separator")) continue;
    out.push(entry);
  }
  if (out.at(-1) === "separator") out.pop();
  return out;
}

/**
 * For dialogs that contain menu targets: the menu is portalled outside the dialog, so a
 * press on one of its rows would count as a click outside and close the dialog before the
 * row's action runs. Pass as the dialog's `onPointerDownOutside`.
 */
export function keepOpenForContextMenu(event: { target: EventTarget | null; preventDefault: () => void }): void {
  if (event.target instanceof Element && event.target.closest("[data-context-menu]") !== null) event.preventDefault();
}

/** How far inside a region's box a menu opens when the point asked for lies outside the window. */
const OFFSCREEN_INSET_PX = 8;

export const MENU_CONTENT_CLASS = "z-50 min-w-40 rounded-md border border-line bg-surface p-1 text-sm shadow-lg";
export const MENU_ITEM_CLASS = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[highlighted]:bg-sunken";

/** Radix items for a list of entries; shared by the context menu and 「⋯」 menus. */
export function MenuEntries(props: { entries: readonly MenuEntry[]; testIdPrefix?: string }) {
  return (
    <>
      {props.entries.map((entry, index) =>
        entry === "separator" ? (
          <DropdownMenu.Separator key={`separator-${index}`} className="my-1 h-px bg-line" />
        ) : (
          <DropdownMenu.Item
            key={entry.id}
            className={MENU_ITEM_CLASS}
            disabled={entry.disabled === true}
            onSelect={() => entry.onSelect()}
            {...(props.testIdPrefix === undefined ? {} : { "data-testid": `${props.testIdPrefix}${entry.id}` })}
          >
            {entry.icon}
            {entry.label}
          </DropdownMenu.Item>
        ),
      )}
    </>
  );
}

interface OpenMenu {
  key: number;
  x: number;
  y: number;
  entries: MenuEntry[];
}

/**
 * The one place right clicks are decided. Text fields keep the system edit
 * menu; otherwise the selection, the link and the innermost registered object under the
 * pointer make up the menu. On the web nothing is intercepted unless an object answers, so
 * the browser menu stays everywhere else; with `blockNative` (desktop client) the WebView
 * menu is always suppressed and, with nothing to offer, no menu opens.
 */
export function ContextMenuHost(props: { blockNative: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [registry] = useState(() => new WeakMap<Element, ProviderRef>());
  const [menu, setMenu] = useState<OpenMenu | undefined>(undefined);
  const settings = useRef({ blockNative: props.blockNative, t: t as Translate });
  settings.current = { blockNative: props.blockNative, t: t as Translate };
  const restore = useRef<HTMLElement | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const counter = useRef(0);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      if (event.defaultPrevented) return;
      const raw = event.target;
      let target = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null;
      if (target === null || isTextEditableTarget(target)) return;
      const { blockNative, t: translate } = settings.current;
      let { clientX: x, clientY: y } = event;
      let selection = selectionAt(x, y);
      if (selection === undefined && (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight)) {
        const kept = keptSelection(document);
        if (kept !== undefined) {
          selection = kept.selection;
          target = kept.element;
          // Opened inside the region, as near the reported point as the region reaches.
          const box = kept.element.getBoundingClientRect();
          x = Math.min(Math.max(x, box.left + OFFSCREEN_INSET_PX), Math.max(box.left, box.right - OFFSCREEN_INSET_PX));
          y = Math.min(Math.max(y, box.top + OFFSCREEN_INSET_PX), Math.max(box.top, box.bottom - OFFSCREEN_INSET_PX));
        }
      }
      const link = linkAt(target, window.location.origin);
      const hit: MenuHit = { target, ...(selection === undefined ? {} : { selection }), ...(link === undefined ? {} : { anchor: link }) };
      const touch = "pointerType" in event && (event as PointerEvent).pointerType === "touch";
      const model = modelAt(registry, hit, touch);
      if (model === undefined && !blockNative) return;
      event.preventDefault();
      const entries = assembleMenu(hit, model, blockNative, translate);
      if (entries.length === 0) return;
      if (x === 0 && y === 0) {
        // Menu key / Shift+F10: no pointer position, so open under the target.
        const box = target.getBoundingClientRect();
        x = box.left;
        y = box.bottom;
      }
      const active = document.activeElement;
      restore.current = active instanceof HTMLElement && active !== document.body ? active : null;
      counter.current += 1;
      setMenu({ key: counter.current, x, y, entries });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [registry]);

  useEffect(() => {
    setMenu(undefined);
  }, [location.key]);

  const open = menu !== undefined;
  useEffect(() => {
    if (!open) return undefined;
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && content.current?.contains(event.target)) return;
      setMenu(undefined);
    };
    window.addEventListener("scroll", onScroll, { capture: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [open]);

  return (
    <RegistryContext.Provider value={registry}>
      {props.children}
      {menu === undefined ? null : (
        <DropdownMenu.Root key={menu.key} open modal={false} onOpenChange={(next) => (next ? undefined : setMenu(undefined))}>
          <DropdownMenu.Trigger asChild disabled>
            <div
              ref={anchor}
              aria-hidden="true"
              tabIndex={-1}
              data-testid="context-menu-anchor"
              style={{ position: "fixed", left: menu.x, top: menu.y, width: 0, height: 0, pointerEvents: "none" }}
            />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal container={fullscreenHost()}>
            <DropdownMenu.Content
              ref={content}
              align="start"
              side="bottom"
              sideOffset={2}
              collisionPadding={8}
              aria-label={t("common.menu.label")}
              data-testid="context-menu"
              data-context-menu=""
              className={MENU_CONTENT_CLASS}
              onCloseAutoFocus={(event) => {
                // Radix would focus the hidden anchor. Give focus back only when no action
                // moved it (a dialog took it, a navigation happened, the element is gone).
                event.preventDefault();
                const previous = restore.current;
                restore.current = null;
                const active = document.activeElement;
                const untouched = active === null || active === document.body || active === anchor.current || (content.current?.contains(active) ?? false);
                if (previous !== null && previous.isConnected && untouched) previous.focus({ preventScroll: true });
              }}
            >
              <MenuEntries entries={menu.entries} testIdPrefix="context-menu-item-" />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </RegistryContext.Provider>
  );
}
