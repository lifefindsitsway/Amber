import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, ChevronRight, FolderOpen, Library, ListTodo, NotebookPen, PanelLeftClose, PanelLeftOpen, Pin, Plus, Search, Settings, Sparkles, Trash2, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { matchPath, NavLink, useLocation, useNavigate } from "react-router";
import { SIDEBAR_COLLECTION_ITEMS, SIDEBAR_RECENT_ITEMS, THEME_DEFAULT, UI_LANGUAGE_DEFAULT } from "../../shared/defaults.ts";
import { collectionDetailDtoSchema, collectionDtoSchema, type CollectionDto, type CollectionItemDto } from "../../shared/dto/collection.ts";
import { contentDetailDtoSchema, type ContentDto } from "../../shared/dto/content.ts";
import { THEMES } from "../../shared/dto/settings.ts";
import type { ProcessingStatus } from "../../shared/enums.ts";
import { languageNames } from "../../shared/i18n/zh-CN/languages.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, useCollections, useContents, usePatchSettings, useSettings, useMe, useUnfinishedTasks, useVersion } from "../api/queries.ts";
import { useIsServerAdmin, useLogout } from "../auth/auth-gate.tsx";
import { useCollectionActions } from "../components/collection/use-collection-actions.tsx";
import { ContentRowMenu } from "../components/content-row-menu.tsx";
import { actionTarget, useContentActions } from "../components/use-content-actions.tsx";
import { ErrorView } from "../components/error-view.tsx";
import { RESOURCES } from "../i18n.ts";
import { useReportSidebarWidth } from "../layout-width.tsx";
import { listLoopState } from "../player/list-loop.ts";
import { Button } from "../ui/button.tsx";
import { useContextMenuTarget } from "../ui/context-menu.tsx";
import { Modal } from "../ui/modal.tsx";
import { Splitter } from "../ui/splitter.tsx";
import { AboutDialog } from "./about-dialog.tsx";
import { SloganMark } from "./slogan-mark.tsx";
import { useOpenTasksRequest, useTaskListRefresh } from "./task-panel.tsx";

const COLLAPSED_KEY = "amber.sidebar.collapsed";
const WIDTH_KEY = "amber.sidebar.width";
const RECENT_COLLAPSED_KEY = "amber.sidebar.recentCollapsed";
/**
 * The draggable range of the expanded column. The upper bound keeps the
 * content page's middle and right columns above their own minimums on common windows;
 * narrower windows fall back to the drawer / single-column layouts as before.
 */
const SIDEBAR_WIDTH_MIN_PX = 200;
const SIDEBAR_WIDTH_MAX_PX = 400;
const SIDEBAR_WIDTH_DEFAULT_PX = 240;
/** The icon bar (`w-14`). */
const SIDEBAR_COLLAPSED_PX = 56;

const STATUS_DOT: Record<ProcessingStatus, string> = {
  queued: "bg-muted",
  running: "bg-accent animate-pulse",
  waiting: "bg-accent",
  succeeded: "bg-ok",
  failed: "bg-danger",
  cancelled: "bg-line",
};

/** A window of at most `size` items around the current one, so the current lecture is visible. */
export function itemsNear<T>(items: readonly T[], currentIndex: number, size: number): T[] {
  if (items.length <= size) return [...items];
  const start = Math.min(Math.max(0, currentIndex - Math.floor(size / 2)), items.length - size);
  return items.slice(start, start + size);
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Private mode without storage: the state just is not remembered. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; the session keeps working.
  }
}

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX_PX, Math.max(SIDEBAR_WIDTH_MIN_PX, Math.round(width)));
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : SIDEBAR_WIDTH_DEFAULT_PX;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT_PX;
  }
}

/** The collection being browsed: its own page, or a lecture page whose Content belongs to it. */
function useCurrentCollection(): { collectionId?: string; contentId?: string } {
  const { pathname } = useLocation();
  const api = useApi();
  const collectionMatch = matchPath("/collections/:id", pathname);
  const contentMatch = matchPath("/contents/:id", pathname);
  const contentId = contentMatch?.params.id;
  const content = useQuery({
    queryKey: queryKeys.content(contentId ?? ""),
    queryFn: () => api.get(`/api/contents/${encodeURIComponent(contentId ?? "")}`, contentDetailDtoSchema),
    enabled: contentId !== undefined,
  });
  const collectionId = collectionMatch?.params.id ?? content.data?.collections[0]?.id;
  return { ...(collectionId === undefined ? {} : { collectionId }), ...(contentId === undefined ? {} : { contentId }) };
}

/**
 * Left column, the same on every page: slogan, search and collapse, the new-summary button,
 * the fixed entries, the collections, 「最近」, the tasks entry and the account card.
 */
export function Sidebar(props: { onOpenOmnibox: () => void; onOpenTasks: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => readFlag(COLLAPSED_KEY));
  const [width, setWidth] = useState(readWidth);
  const [recentCollapsed, setRecentCollapsed] = useState(() => readFlag(RECENT_COLLAPSED_KEY));
  const [creating, setCreating] = useState(false);
  // Explicit toggles only; a collection nobody toggled follows the one being browsed.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const collections = useCollections();
  // 「最近」 holds what is not filed into a collection yet, pinned first.
  const recent = useContents({ limit: SIDEBAR_RECENT_ITEMS, uncollected: true });
  const tasks = useUnfinishedTasks();
  const current = useCurrentCollection();
  useTaskListRefresh();
  useOpenTasksRequest(props.onOpenTasks);

  const reportWidth = useReportSidebarWidth();
  useEffect(() => reportWidth(collapsed ? SIDEBAR_COLLAPSED_PX : width), [reportWidth, collapsed, width]);

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    remember(COLLAPSED_KEY, next ? "1" : "0");
  };
  const toggleRecent = (): void => {
    const next = !recentCollapsed;
    setRecentCollapsed(next);
    remember(RECENT_COLLAPSED_KEY, next ? "1" : "0");
  };
  const resetWidth = (): void => {
    setWidth(SIDEBAR_WIDTH_DEFAULT_PX);
    remember(WIDTH_KEY, String(SIDEBAR_WIDTH_DEFAULT_PX));
  };
  // Deleting the Content being read leaves its page, as the content page's own menu does.
  const onDeleted = (contentId: string): void => {
    if (contentId === current.contentId) void navigate("/library", { replace: true });
  };
  const taskCount = tasks.data?.items.length ?? 0;
  const recentItems = recent.data?.items ?? [];
  const recentTotal = recent.data?.total ?? 0;

  return (
    <nav
      data-testid="sidebar"
      data-collapsed={collapsed}
      className={`relative flex shrink-0 flex-col border-r border-line bg-panel ${collapsed ? "w-14" : ""}`}
      {...(collapsed ? {} : { style: { width } })}
    >
      <div className={`flex items-center gap-1 px-2 ${collapsed ? "flex-col justify-center py-2" : "min-h-12 py-1"}`}>
        {/* The one-line slogan fills whatever width the column leaves beside the buttons, so it scales with the column. */}
        {collapsed ? null : (
          <div className="flex min-w-0 flex-1 justify-center px-1">
            <SloganMark label={t("shell.sidebar.slogan")} className="block h-auto w-full text-accent" />
          </div>
        )}
        <IconButton label={t("common.nav.search")} onClick={props.onOpenOmnibox}>
          <Search size={16} />
        </IconButton>
        <IconButton label={collapsed ? t("common.nav.expand") : t("common.nav.collapse")} onClick={toggle}>
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </IconButton>
      </div>
      <div className="px-2">
        <NavLink to="/new" data-testid="sidebar-new" title={t("common.nav.newSummary")} className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-accent-glow px-3 text-sm font-medium text-accent-ink hover:brightness-105">
          <Sparkles size={16} aria-hidden="true" />
          {collapsed ? null : t("common.nav.newSummary")}
        </NavLink>
      </div>
      <div className="mt-2 flex flex-col gap-0.5 px-2">
        <NavItem to="/library" icon={<Library size={16} />} label={t("common.nav.library")} collapsed={collapsed} />
        <NavItem to="/collections" icon={<FolderOpen size={16} />} label={t("common.nav.collections")} collapsed={collapsed} end />
        <NavItem to="/notes" icon={<NotebookPen size={16} />} label={t("common.nav.notes")} collapsed={collapsed} />
        <NavItem to="/trash" icon={<Trash2 size={16} />} label={t("common.nav.trash")} collapsed={collapsed} testId="sidebar-trash" />
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-auto px-2">
        {collapsed ? null : (
          <>
            <Group title={t("common.nav.collections")} action={<IconButton label={t("shell.sidebar.newCollection")} onClick={() => setCreating(true)}><Plus size={14} /></IconButton>}>
              {(collections.data?.items ?? []).length === 0 ? <p className="px-2 py-1 text-xs text-muted">{t("shell.sidebar.noCollections")}</p> : null}
              {(collections.data?.items ?? []).map((collection) => {
                const open = collection.itemCount > 0 && (expanded[collection.id] ?? collection.id === current.collectionId);
                return (
                  <CollectionRow
                    key={collection.id}
                    collection={collection}
                    open={open}
                    contentId={current.contentId}
                    onToggle={() => setExpanded((previous) => ({ ...previous, [collection.id]: !open }))}
                    onDeleted={onDeleted}
                  />
                );
              })}
            </Group>
            <section className="mb-3" data-testid="sidebar-recent">
              <button
                type="button"
                aria-expanded={!recentCollapsed}
                aria-label={recentCollapsed ? t("shell.sidebar.expandRecent") : t("shell.sidebar.collapseRecent")}
                onClick={toggleRecent}
                className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted hover:bg-sunken hover:text-ink"
              >
                <span className="flex-1 text-left">{t("common.nav.recent")}</span>
                {recentTotal > 0 ? (
                  <span className="tabular-nums" title={t("shell.sidebar.recentCount", { count: recentTotal })} data-testid="recent-count">
                    {recentTotal}
                  </span>
                ) : null}
                <ChevronDown size={14} aria-hidden="true" className={recentCollapsed ? "-rotate-90" : ""} />
              </button>
              {recentCollapsed ? null : (
                <div className="flex flex-col gap-0.5">
                  {recentItems.length === 0 ? <p className="px-2 py-1 text-xs text-muted">{t("shell.sidebar.noRecent")}</p> : null}
                  {recentItems.map((content) => (
                    <RecentRow key={content.id} content={content} onDeleted={onDeleted} />
                  ))}
                  {recentTotal > recentItems.length ? (
                    <NavLink to="/library?uncollected=1" className="px-2 py-1 text-xs text-accent hover:underline" data-testid="recent-view-all">
                      {t("common.action.viewAll")}
                    </NavLink>
                  ) : null}
                </div>
              )}
            </section>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-line p-2">
        <button type="button" data-testid="sidebar-tasks" onClick={props.onOpenTasks} title={t("common.nav.tasks")} className={`${rowClass(false)} ${collapsed ? "justify-center" : ""}`}>
          <ListTodo size={16} aria-hidden="true" />
          {collapsed ? null : <span className="flex-1 text-left">{t("common.nav.tasks")}</span>}
          {taskCount > 0 ? <span className="rounded-full bg-accent-glow px-1.5 text-xs text-accent-ink">{taskCount}</span> : null}
        </button>
        <AccountMenu collapsed={collapsed} />
      </div>
      <NewCollectionDialog open={creating} onOpenChange={setCreating} />
      {collapsed ? null : (
        <Splitter
          label={t("shell.sidebar.resize")}
          testId="sidebar-splitter"
          className="absolute inset-y-0 -right-1 z-10 w-2 hover:bg-accent/40"
          onResize={(delta) => setWidth((value) => clampWidth(value + delta))}
          onEnd={() => remember(WIDTH_KEY, String(width))}
          onReset={resetWidth}
        />
      )}
    </nav>
  );
}

/**
 * A Content in 「最近」: status dot, title (pinned ones marked) and its 「⋯」 menu beside the
 * link, never inside it. A right click on the row offers the same actions plus "open".
 */
function RecentRow(props: { content: ContentDto; onDeleted: (contentId: string) => void }) {
  const { t } = useTranslation();
  const { content } = props;
  const title = content.title ?? t("shell.sidebar.untitled");
  const actions = useContentActions({ onDeleted: props.onDeleted });
  const target = actionTarget({ id: content.id, title: content.title, pinnedAt: content.pinnedAt, sourceUrl: content.source.sourceUrl });
  const menuRef = useContextMenuTarget<HTMLDivElement>((hit) => actions.menu(target, hit));
  return (
    <div ref={menuRef} className="group relative" data-testid="recent-row">
      <NavLink to={`/contents/${content.id}`} className={({ isActive }) => `${rowClass(isActive)} pr-8`}>
        <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[content.processingStatus]}`} title={t(`common.status.${content.processingStatus}`)} />
        <span className="truncate">{title}</span>
        {content.pinnedAt === undefined ? null : <Pin size={12} className="ml-auto shrink-0 text-accent" aria-label={t("shell.sidebar.pinned")} />}
      </NavLink>
      <ContentRowMenu actions={actions} content={target} label={title} className="absolute top-1 right-1" />
      {actions.dialogs}
    </div>
  );
}

/**
 * A collection with its lecture count and a disclosure button. The button sits beside the link,
 * never inside it, so the name still opens the collection page; an empty collection has neither.
 */
function CollectionRow(props: { collection: CollectionDto; open: boolean; contentId: string | undefined; onToggle: () => void; onDeleted: (contentId: string) => void }) {
  const { t } = useTranslation();
  const { id, name, itemCount } = props.collection;
  const filled = itemCount > 0;
  const actions = useCollectionActions(props.collection);
  // The whole block: expanded lectures answer with their own menus first, the rest
  // (the row, the "view all" link) is the collection.
  const menuTarget = useContextMenuTarget<HTMLDivElement>(() => ({ kind: "object", href: `/collections/${id}`, entries: actions.menu("context") }));
  return (
    <div ref={menuTarget} data-testid="sidebar-collection">
      <div className="relative">
        <NavLink to={`/collections/${id}`} className={({ isActive }) => `${rowClass(isActive)} ${filled ? "pr-8" : ""}`}>
          <span className="truncate">{name}</span>
          {filled ? (
            <span className="ml-auto shrink-0 text-xs text-muted tabular-nums" title={t("library.collections.itemCount", { count: itemCount })}>
              {itemCount}
            </span>
          ) : null}
        </NavLink>
        {filled ? (
          <button
            type="button"
            aria-expanded={props.open}
            aria-label={t(props.open ? "shell.sidebar.collapseCollection" : "shell.sidebar.expandCollection", { name })}
            onClick={props.onToggle}
            className="absolute top-1 right-1 flex size-6 items-center justify-center rounded text-muted hover:bg-line hover:text-ink"
          >
            <ChevronDown size={14} aria-hidden="true" className={props.open ? "" : "-rotate-90"} />
          </button>
        ) : null}
      </div>
      {props.open ? <CollectionItems collectionId={id} contentId={props.contentId} onDeleted={props.onDeleted} /> : null}
      {actions.dialogs}
    </div>
  );
}

function rowClass(active: boolean): string {
  return `flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm ${active ? "bg-sunken font-medium" : "hover:bg-sunken"}`;
}

function NavItem(props: { to: string; icon: ReactNode; label: string; collapsed: boolean; end?: boolean; testId?: string }) {
  return (
    <NavLink to={props.to} end={props.end === true} title={props.label} {...(props.testId === undefined ? {} : { "data-testid": props.testId })} className={({ isActive }) => `${rowClass(isActive)} ${props.collapsed ? "justify-center" : ""}`}>
      {props.icon}
      {props.collapsed ? null : <span className="truncate">{props.label}</span>}
    </NavLink>
  );
}

function Group(props: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-3">
      <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted">
        <span>{props.title}</span>
        {props.action}
      </div>
      <div className="flex flex-col gap-0.5">{props.children}</div>
    </section>
  );
}

function IconButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={props.label} title={props.label} onClick={props.onClick} className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink">
      {props.children}
    </button>
  );
}

/**
 * The lectures near the current one; each row has the same 「⋯」 and right-click menus as
 * 「最近」. The list answers right clicks for its rows; elsewhere (the
 * "view all" link) it declines, leaving the click to the collection around it.
 */
function CollectionItems(props: { collectionId: string; contentId: string | undefined; onDeleted: (contentId: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const detail = useQuery({
    queryKey: queryKeys.collection(props.collectionId),
    queryFn: () => api.get(`/api/collections/${encodeURIComponent(props.collectionId)}`, collectionDetailDtoSchema),
  });
  const actions = useContentActions({ onDeleted: props.onDeleted });
  const items: CollectionItemDto[] = detail.data?.items ?? [];
  const index = items.findIndex((item) => item.contentId === props.contentId);
  const shown = itemsNear(items, Math.max(0, index), SIDEBAR_COLLECTION_ITEMS);
  const targetOf = (item: CollectionItemDto) =>
    actionTarget({ id: item.contentId, title: item.title, pinnedAt: item.pinnedAt, sourceUrl: item.sourceUrl });
  const menuRef = useContextMenuTarget<HTMLDivElement>((hit) => {
    const row = hit.target.closest<HTMLElement>("[data-item-id]");
    const item = shown.find((candidate) => candidate.id === row?.dataset["itemId"]);
    return item === undefined ? undefined : actions.menu(targetOf(item), hit);
  });
  return (
    <div ref={menuRef} data-testid="sidebar-collection-items" className="ml-3 flex flex-col gap-0.5 border-l border-line pl-1">
      {shown.map((item) => {
        const title = item.title ?? t("shell.sidebar.untitled");
        return (
          <div key={item.id} className="group relative" data-testid="collection-item-row" data-item-id={item.id}>
            <NavLink
              to={`/contents/${item.contentId}`}
              state={listLoopState({ collectionId: props.collectionId })}
              className={({ isActive }) => `${rowClass(isActive)} h-7 pr-7 text-xs`}
            >
              <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[item.processingStatus]}`} />
              <span className="truncate">{title}</span>
            </NavLink>
            <ContentRowMenu actions={actions} content={targetOf(item)} label={title} className="absolute top-0.5 right-0.5" />
          </div>
        );
      })}
      {items.length > shown.length ? (
        <NavLink to={`/collections/${props.collectionId}`} className="px-2 py-1 text-xs text-accent hover:underline">
          {t("common.action.viewAll")}
        </NavLink>
      ) : null}
      {actions.dialogs}
    </div>
  );
}

function AccountMenu(props: { collapsed: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  const version = useVersion();
  const settings = useSettings();
  const patch = usePatchSettings();
  const logout = useLogout();
  const admin = useIsServerAdmin();
  const [about, setAbout] = useState(false);
  const server = me.data?.mode === "server";
  // The authentication boundary loaded `me` before the shell mounted. The desktop client has
  // no users to show, so its card is the settings entry.
  const name = server ? (me.data?.displayName ?? me.data?.username ?? "") : t("shell.sidebar.localSettings");
  const item = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-sunken";
  const label = "px-2 pt-1.5 pb-1 text-xs text-muted";
  const menu = "z-50 rounded-md border border-line bg-surface p-1 shadow-lg";
  const language = settings.data?.language ?? UI_LANGUAGE_DEFAULT;
  const theme = settings.data?.theme ?? THEME_DEFAULT;
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          data-testid="account-card"
          className={`${rowClass(false)} ${props.collapsed ? "justify-center" : ""}`}
          {...(props.collapsed ? { "aria-label": name, title: name } : {})}
        >
          {server ? <UserRound size={16} aria-hidden="true" /> : <Settings size={16} aria-hidden="true" />}
          {props.collapsed ? null : <span className="truncate">{name}</span>}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="start" sideOffset={6} className={`${menu} min-w-52`}>
            <DropdownMenu.Item className={item} onSelect={() => void navigate("/settings/models")}>
              {t("common.nav.settings")}
            </DropdownMenu.Item>
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className={item}>
                {t("shell.sidebar.appearance")}
                <ChevronRight size={14} className="ml-auto text-muted" aria-hidden="true" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className={`${menu} min-w-40`}>
                  <DropdownMenu.Label className={label}>{t("shell.sidebar.theme")}</DropdownMenu.Label>
                  <DropdownMenu.RadioGroup
                    value={theme}
                    onValueChange={(value) => {
                      const next = THEMES.find((option) => option === value);
                      if (next !== undefined) patch.mutate({ theme: next });
                    }}
                  >
                    {THEMES.map((option) => (
                      <DropdownMenu.RadioItem key={option} value={option} className={item}>
                        <RadioMark />
                        {t(`common.theme.${option}`)}
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                  <DropdownMenu.Separator className="my-1 h-px bg-line" />
                  <DropdownMenu.Label className={label}>{t("shell.sidebar.language")}</DropdownMenu.Label>
                  {/* One entry per bundled language resource; adding a language adds an entry here. */}
                  <DropdownMenu.RadioGroup value={language} onValueChange={(value) => patch.mutate({ language: value })}>
                    {Object.keys(RESOURCES).map((option) => (
                      <DropdownMenu.RadioItem key={option} value={option} className={item}>
                        <RadioMark />
                        {languageNames[option] ?? option}
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
            <DropdownMenu.Item className={item} onSelect={() => void navigate("/usage")} data-testid="account-usage">
              {t("shell.sidebar.usage")}
            </DropdownMenu.Item>
            {server ? (
              <DropdownMenu.Item className={item} onSelect={() => void navigate("/account/password")}>
                {t("shell.sidebar.changePassword")}
              </DropdownMenu.Item>
            ) : null}
            {admin ? (
              <DropdownMenu.Item className={item} onSelect={() => void navigate("/admin")}>
                {t("shell.sidebar.admin")}
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item className={item} onSelect={() => setAbout(true)}>
              {t("shell.sidebar.about")}
              {version.data === undefined ? null : (
                <span className="ml-auto pl-4 text-xs text-muted">{t("shell.sidebar.version", { version: version.data.version })}</span>
              )}
            </DropdownMenu.Item>
            {server ? (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item className={item} onSelect={() => void logout()}>
                  {t("shell.sidebar.logout")}
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <AboutDialog open={about} onOpenChange={setAbout} />
    </>
  );
}

/** The check of the selected radio item; the empty slot keeps labels aligned. */
function RadioMark() {
  return (
    <span className="flex w-3.5 justify-center">
      <DropdownMenu.ItemIndicator>
        <Check size={14} />
      </DropdownMenu.ItemIndicator>
    </span>
  );
}

function NewCollectionDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.post("/api/collections", collectionDtoSchema, { body: { name: name.trim(), ...(description.trim() === "" ? {} : { description: description.trim() }) } }),
    onSuccess: (collection) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.collections });
      props.onOpenChange(false);
      setName("");
      setDescription("");
      void navigate(`/collections/${collection.id}`);
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (name.trim() !== "") create.mutate();
  };
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={t("shell.sidebar.newCollectionTitle")}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t("shell.sidebar.collectionName")}
          <input value={name} onChange={(event) => setName(event.target.value)} className="h-9 rounded-md border border-line bg-surface px-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("shell.sidebar.collectionDescription")}
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="rounded-md border border-line bg-surface px-2 py-1" />
        </label>
        {create.error instanceof ApiError ? <ErrorView error={create.error.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => props.onOpenChange(false)}>{t("common.action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={name.trim() === "" || create.isPending}>
            {t("common.action.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
