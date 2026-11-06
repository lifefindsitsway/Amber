import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { useTranslation } from "react-i18next";
import { AuthGate } from "./auth/auth-gate.tsx";
import { DesktopIntegration } from "./desktop/desktop-integration.tsx";
import { useDesktop } from "./desktop/use-desktop.ts";
import { AppShell } from "./shell/app-shell.tsx";
import { ContextMenuHost } from "./ui/context-menu.tsx";
import { EmptyState, Loading } from "./ui/feedback.tsx";

// Pages load on first visit so the initial bundle carries only the shell.
const NewPage = lazy(async () => ({ default: (await import("./pages/new-page.tsx")).NewPage }));
const LibraryPage = lazy(async () => ({ default: (await import("./pages/library-page.tsx")).LibraryPage }));
const CollectionsPage = lazy(async () => ({ default: (await import("./pages/collections-page.tsx")).CollectionsPage }));
const CollectionPage = lazy(async () => ({ default: (await import("./pages/collection-page.tsx")).CollectionPage }));
const NotesPage = lazy(async () => ({ default: (await import("./pages/notes-page.tsx")).NotesPage }));
const TrashPage = lazy(async () => ({ default: (await import("./pages/trash-page.tsx")).TrashPage }));
const ContentPage = lazy(async () => ({ default: (await import("./pages/content/content-page.tsx")).ContentPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./pages/settings/settings-page.tsx")).SettingsPage }));
const UsagePage = lazy(async () => ({ default: (await import("./pages/usage/usage-page.tsx")).UsagePage }));
const AccountPasswordPage = lazy(async () => ({ default: (await import("./pages/account-password-page.tsx")).AccountPasswordPage }));
const AdminPage = lazy(async () => ({ default: (await import("./pages/admin/admin-page.tsx")).AdminPage }));
const LoginPage = lazy(async () => ({ default: (await import("./pages/login-page.tsx")).LoginPage }));
const SetupPage = lazy(async () => ({ default: (await import("./pages/setup-page.tsx")).SetupPage }));

function Page(props: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{props.children}</Suspense>;
}

/**
 * The app's routes: new page, library, collections, notes, trash, content page, settings,
 * AI usage, account, admin, setup and login. `/login` and `/setup` stand outside the authentication
 * boundary and the shell; everything else mounts only for an authenticated principal.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="login" element={<Page><LoginPage /></Page>} />
      <Route path="setup" element={<Page><SetupPage /></Page>} />
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/library" replace />} />
          <Route path="new" element={<Page><NewPage /></Page>} />
          <Route path="library" element={<Page><LibraryPage /></Page>} />
          <Route path="collections" element={<Page><CollectionsPage /></Page>} />
          <Route path="collections/:id" element={<Page><CollectionPage /></Page>} />
          <Route path="notes" element={<Page><NotesPage /></Page>} />
          <Route path="trash" element={<Page><TrashPage /></Page>} />
          <Route path="contents/:id" element={<Page><ContentPage /></Page>} />
          <Route path="settings" element={<Navigate to="/settings/models" replace />} />
          <Route path="settings/:section" element={<Page><SettingsPage /></Page>} />
          <Route path="usage" element={<Page><UsagePage /></Page>} />
          <Route path="account/password" element={<Page><AccountPasswordPage /></Page>} />
          <Route path="admin" element={<Navigate to="/admin/users" replace />} />
          <Route path="admin/:section" element={<Page><AdminPage /></Page>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return <EmptyState title={t("errors.not_found")} />;
}

/** The context-menu host; in the desktop client it also suppresses the WebView menu. */
function ContextMenus(props: { children: ReactNode }) {
  return <ContextMenuHost blockNative={useDesktop()}>{props.children}</ContextMenuHost>;
}

export function App() {
  return (
    <BrowserRouter>
      <DesktopIntegration />
      <ContextMenus>
        <AppRoutes />
      </ContextMenus>
    </BrowserRouter>
  );
}
