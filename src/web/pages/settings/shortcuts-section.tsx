import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  effectiveShortcuts,
  normalizeShortcut,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFAULTS,
  shortcutProblems,
  type ShortcutAction,
} from "../../../shared/shortcuts.ts";
import { usePatchSettings, useSettings } from "../../api/queries.ts";
import { comboOf, useShortcutRegistry } from "../../shortcut-registry.tsx";
import { Button, FOCUS_RING } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { FieldError } from "../../ui/notice.tsx";
import { TextInput } from "../../ui/text-field.tsx";
import { RequestError, SettingsBlock } from "./settings-ui.tsx";

const MODIFIER_KEY_NAMES = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/**
 * `/settings/shortcuts`: rebinding the registry's actions. Combinations
 * are validated against the reserved-key table and each other before anything is saved.
 */
export function ShortcutsSection() {
  const { t } = useTranslation();
  const settings = useSettings();
  const patch = usePatchSettings();
  const [draft, setDraft] = useState<Partial<Record<ShortcutAction, string>>>({});
  const [capturing, setCapturing] = useState<ShortcutAction | undefined>(undefined);
  if (settings.data === undefined) {
    return settings.isPending ? <Loading /> : <RequestError error={settings.error} />;
  }
  const effective = effectiveShortcuts(settings.data.shortcuts);
  const proposed = { ...effective, ...draft };
  const problems = shortcutProblems(proposed);
  const changed = (Object.keys(draft) as ShortcutAction[]).filter((action) => draft[action] !== effective[action]);
  const blocked = Object.keys(problems).length > 0;

  const record = (action: ShortcutAction, combo: string): void => {
    setDraft((current) => ({ ...current, [action]: normalizeShortcut(combo) ?? combo }));
    setCapturing(undefined);
  };

  return (
    <>
      <SettingsBlock intro={t("settings.shortcuts.intro")}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-2 font-medium">{t("settings.shortcuts.action")}</th>
              <th className="pb-2 font-medium">{t("settings.shortcuts.combo")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {SHORTCUT_ACTIONS.map((action) => {
              const problem = problems[action];
              const problemId = `shortcut-problem-${action}`;
              return (
                <tr key={action} className="border-t border-line align-top" data-action={action}>
                  <td className="py-2">{t(`common.shortcut.${action}`)}</td>
                  <td className="py-2">
                    {capturing === action ? (
                      <CaptureField
                        label={t(`common.shortcut.${action}`)}
                        problemId={problem === undefined ? undefined : problemId}
                        onCombo={(combo) => record(action, combo)}
                        onCancel={() => setCapturing(undefined)}
                      />
                    ) : (
                      <button
                        type="button"
                        className={`rounded border bg-sunken px-2 py-1 font-mono text-xs hover:border-accent ${problem === undefined ? "border-line" : "border-danger"} ${FOCUS_RING}`}
                        aria-label={`${t(`common.shortcut.${action}`)} ${proposed[action]}`}
                        aria-describedby={problem === undefined ? undefined : problemId}
                        onClick={() => setCapturing(action)}
                      >
                        {proposed[action]}
                      </button>
                    )}
                    {problem === undefined ? null : (
                      <FieldError id={problemId} className="mt-1.5" testId={`shortcut-problem-${action}`}>
                        {t(`settings.shortcuts.problem.${problem}`)}
                      </FieldError>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={settings.data.shortcuts[action] === undefined && draft[action] === undefined}
                      onClick={() => {
                        setDraft((current) => {
                          const next = { ...current };
                          delete next[action];
                          return next;
                        });
                        if (settings.data.shortcuts[action] !== undefined) {
                          patch.mutate({ shortcuts: { [action]: null } });
                        }
                      }}
                      title={SHORTCUT_DEFAULTS[action]}
                    >
                      {t("settings.shortcuts.reset")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <RequestError error={patch.error} />
      </SettingsBlock>
      {/* It saves the whole table, so it sits under the block rather than inside it. */}
      <div className="-mt-3 mb-6 flex justify-end" data-testid="shortcuts-actions">
        <Button
          variant="primary"
          disabled={blocked || changed.length === 0 || patch.isPending}
          onClick={() =>
            patch.mutate(
              { shortcuts: Object.fromEntries(changed.map((action) => [action, proposed[action]])) },
              { onSuccess: () => setDraft({}) },
            )
          }
        >
          {t("common.action.save")}
        </Button>
      </div>
    </>
  );
}

/**
 * Records the next key combination. The registry is suspended while capturing, so bound
 * combinations reach this field instead of triggering their actions.
 */
function CaptureField(props: { label: string; problemId: string | undefined; onCombo: (combo: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const registry = useShortcutRegistry();
  const { onCombo } = props;
  useEffect(() => registry.suspend(), [registry]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (MODIFIER_KEY_NAMES.has(event.key) || event.key === "Tab") {
      return;
    }
    event.preventDefault();
    if (event.key === "Escape") {
      props.onCancel();
      return;
    }
    onCombo(comboOf(event.nativeEvent));
  };
  return (
    <TextInput
      autoFocus
      readOnly
      size="sm"
      aria-label={props.label}
      aria-describedby={props.problemId}
      invalid={props.problemId !== undefined}
      className="w-40 font-mono"
      placeholder={t("settings.shortcuts.capture")}
      onKeyDown={onKeyDown}
      onBlur={props.onCancel}
    />
  );
}
