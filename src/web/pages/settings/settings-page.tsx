import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, NavLink, useParams } from "react-router";
import { useApi } from "../../api/context.tsx";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { PageHeader } from "../../ui/feedback.tsx";
import { BackupSection } from "./backup-section.tsx";
import { ModelsSection } from "./models-section.tsx";
import { OtherModelsSection } from "./other-models-section.tsx";
import { PlatformAccountsSection } from "./platform-accounts-section.tsx";
import { ShortcutsSection } from "./shortcuts-section.tsx";
import { StorageSection } from "./storage-section.tsx";
import { TemplatesSection } from "./templates-section.tsx";
import { TerminologySection } from "./terminology-section.tsx";
import { TranscriptionSection } from "./transcription-section.tsx";
import { WebSearchSection } from "./web-search-section.tsx";

/**
 * Feature settings sections, in the order the settings page lists them. Appearance, password
 * and administration live in the account menu; 「备份与恢复」 is listed in the desktop client only.
 */
export const SETTINGS_SECTIONS = ["models", "transcription", "other-models", "web-search", "platform-accounts", "templates", "terminology", "storage", "backup", "shortcuts"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Sections that exist only in the desktop client. */
const DESKTOP_SECTIONS: ReadonlySet<SettingsSection> = new Set(["backup"]);
const SECTION_VIEWS: Record<SettingsSection, ComponentType> = {
  models: ModelsSection,
  transcription: TranscriptionSection,
  "other-models": OtherModelsSection,
  "web-search": WebSearchSection,
  "platform-accounts": PlatformAccountsSection,
  templates: TemplatesSection,
  terminology: TerminologySection,
  storage: StorageSection,
  backup: BackupSection,
  shortcuts: ShortcutsSection,
};

/** `/settings/:section`: left section nav and the chosen section; unknown sections go to models. */
export function SettingsPage() {
  const { t } = useTranslation();
  const { section } = useParams();
  const desktop = useDesktop();
  // Server mode never has the desktop sections; local mode keeps the route while the shell check settles.
  const server = useApi().mode === "server";
  if (!(SETTINGS_SECTIONS as readonly string[]).includes(section ?? "") || (server && DESKTOP_SECTIONS.has(section as SettingsSection))) {
    return <Navigate to="/settings/models" replace />;
  }
  const current = section as SettingsSection;
  const View = SECTION_VIEWS[current];
  return (
    <div className="@container flex h-full flex-col">
      <PageHeader title={t("settings.title")} />
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 @3xl:w-48 @3xl:flex-col @3xl:border-r @3xl:border-b-0" aria-label={t("settings.title")}>
          {SETTINGS_SECTIONS.filter((item) => desktop || !DESKTOP_SECTIONS.has(item)).map((item) => (
            <NavLink
              key={item}
              to={`/settings/${item}`}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${isActive ? "bg-accent-soft font-medium text-accent" : "hover:bg-sunken"}`
              }
            >
              {t(`settings.section.${item}`)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-3xl" data-settings-section={current}>
            <h2 className="mb-4 text-base font-semibold">{t(`settings.section.${current}`)}</h2>
            <View />
          </div>
        </div>
      </div>
    </div>
  );
}
