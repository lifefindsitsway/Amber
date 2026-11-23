import { ShieldOff } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, NavLink, useParams } from "react-router";
import { useMe } from "../../api/queries.ts";
import { EmptyState, Loading, PageHeader } from "../../ui/feedback.tsx";
import { NOTE_TEXT_CLASS } from "../../ui/notice.tsx";
import { InstanceSettingsEditor } from "../settings/storage-section.tsx";
import { CredentialsSection } from "./credentials-section.tsx";
import { NetworkSection } from "./network-section.tsx";
import { AdminStorageSection } from "./storage-section.tsx";
import { UsersSection } from "./users-section.tsx";

/** Admin areas, in the order the admin page lists them. */
export const ADMIN_SECTIONS = ["users", "storage", "instance", "network", "credentials"] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

function InstanceSection() {
  const { t } = useTranslation();
  return (
    <div>
      <p className={`mb-4 ${NOTE_TEXT_CLASS}`}>{t("admin.instance.intro")}</p>
      <InstanceSettingsEditor />
    </div>
  );
}

const SECTION_VIEWS: Record<AdminSection, ComponentType> = {
  users: UsersSection,
  storage: AdminStorageSection,
  instance: InstanceSection,
  network: NetworkSection,
  credentials: CredentialsSection,
};

/**
 * `/admin/:section`: server-mode administrators only. The server checks the
 * role on every admin endpoint; hiding the page from others is only courtesy.
 */
export function AdminPage() {
  const { t } = useTranslation();
  const { section } = useParams();
  const me = useMe();
  if (me.isPending) {
    return <Loading />;
  }
  if (me.data?.mode !== "server" || me.data.role !== "admin") {
    return <EmptyState icon={<ShieldOff size={28} />} title={t("admin.forbidden")} />;
  }
  if (!(ADMIN_SECTIONS as readonly string[]).includes(section ?? "")) {
    return <Navigate to="/admin/users" replace />;
  }
  const current = section as AdminSection;
  const View = SECTION_VIEWS[current];
  return (
    <div className="@container flex h-full flex-col">
      <PageHeader title={t("admin.title")} />
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 @3xl:w-48 @3xl:flex-col @3xl:border-r @3xl:border-b-0" aria-label={t("admin.title")}>
          {ADMIN_SECTIONS.map((item) => (
            <NavLink
              key={item}
              to={`/admin/${item}`}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${isActive ? "bg-accent-soft font-medium text-accent" : "hover:bg-sunken"}`
              }
            >
              {t(`admin.section.${item}`)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-4xl" data-admin-section={current}>
            <h2 className="mb-4 text-base font-semibold">{t(`admin.section.${current}`)}</h2>
            <View />
          </div>
        </div>
      </div>
    </div>
  );
}
