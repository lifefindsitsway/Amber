import { useTranslation } from "react-i18next";
import { PLAYER_SKIP_SECONDS } from "../../shared/defaults.ts";
import { useShortcutRegistry } from "../shortcut-registry.tsx";
import { Modal } from "../ui/modal.tsx";

/** The shortcut table (SHORTCUT_HELP_DEFAULT): every global binding comes from the registry. */
export function ShortcutHelp(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const registry = useShortcutRegistry();
  const rows: Array<[string, string]> = [
    ...registry.list().map(({ action, combo }): [string, string] => [t(`common.shortcut.${action}`), combo]),
    [t("common.shortcut.playPause"), "Space"],
    [t("common.shortcut.skipBack", { seconds: PLAYER_SKIP_SECONDS }), "←"],
    [t("common.shortcut.skipForward", { seconds: PLAYER_SKIP_SECONDS }), "→"],
    [t("common.shortcut.volume"), "↑ / ↓"],
    [t("common.shortcut.fullscreen"), "F"],
  ];
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={t("common.shortcut.title")}>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([label, combo]) => (
            <tr key={label} className="border-b border-line last:border-0">
              <td className="py-2">{label}</td>
              <td className="py-2 text-right">
                <kbd className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-xs">{combo}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-note text-muted">{t("common.shortcut.playerScope")}</p>
    </Modal>
  );
}
