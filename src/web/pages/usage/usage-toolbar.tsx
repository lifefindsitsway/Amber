import type { TFunction } from "i18next";
import { DropdownMenu } from "radix-ui";
import { useTranslation } from "react-i18next";
import { decodeModelKey, type UsageRange, type UsageSummaryResponse } from "../../../shared/dto/usage-analytics.ts";
import { PRICE_CURRENCIES, type PriceCurrency } from "../../../shared/model-pricing.ts";
import { MENU_CONTENT_CLASS } from "../../ui/context-menu.tsx";
import { currencySymbol } from "../../format.ts";
import { MENU_SCROLL_CLASS, MenuLabel, MenuTrigger, RadioEntry, SegmentedControl } from "./usage-controls.tsx";
import { useNarrowLayout } from "./usage-layout.tsx";
import { credentialVersionLabel, profileName } from "./usage-present.ts";
import { hasUsageFilter, type UsagePatch, type UsageState } from "./usage-state.ts";

type Options = UsageSummaryResponse["options"];
type OptionProfile = Options["profiles"][number];

/** The ranges the segmented control offers, in order; `custom` only comes from a drill-down. */
export const RANGE_PRESETS = ["24h", "48h", "7d", "30d", "all"] as const satisfies readonly UsageRange[];

/** Separator of a profile key and a credential version in one menu value; base64url keys never contain it. */
const VERSION_SEPARATOR = "|";

function credentialValue(state: UsageState): string {
  if (state.profileKey === undefined) return "";
  return state.credentialVersion === undefined ? state.profileKey : `${state.profileKey}${VERSION_SEPARATOR}${state.credentialVersion}`;
}

/**
 * Width classes of a filter trigger. In the wide layout a trigger without a filter of its own
 * shows the short "all" label and never gives way; only a trigger showing a selected (long)
 * name may shrink and truncate, within its maximum width.
 */
function triggerWidth(narrow: boolean, filtered: boolean, maxWidth: string): string {
  if (narrow) return "flex-1";
  return filtered ? maxWidth : "shrink-0";
}

/**
 * The toolbar's left group: credential, model and currency. Menus list what the time range
 * holds, whatever the other filters say, so a filter can always be switched or cleared.
 */
export function UsageToolbar(props: {
  state: UsageState;
  currency: PriceCurrency;
  options: Options | undefined;
  onPatch: (patch: UsagePatch) => void;
  onCurrency: (currency: PriceCurrency) => void;
}) {
  const { t } = useTranslation();
  const narrow = useNarrowLayout();
  const { state } = props;
  const filtered = hasUsageFilter(state);
  const clear = (
    <button
      type="button"
      className="shrink-0 rounded px-1.5 text-sm text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
      data-testid="usage-clear-filters"
      onClick={() => props.onPatch({ profileKey: null, credentialVersion: null, modelKey: null })}
    >
      {t("usage.toolbar.clear")}
    </button>
  );
  const left = (
    <div className="flex min-w-0 items-center gap-2" data-testid="usage-filters">
      <CredentialMenu state={state} options={props.options} onPatch={props.onPatch} className={triggerWidth(narrow, state.profileKey !== undefined, "max-w-[220px]")} compact={narrow} />
      <ModelMenu state={state} options={props.options} onPatch={props.onPatch} className={triggerWidth(narrow, state.modelKey !== undefined, "max-w-[260px]")} compact={narrow} />
      <CurrencyMenu currency={props.currency} onChange={props.onCurrency} compact={narrow} />
      {filtered && !narrow ? clear : null}
    </div>
  );
  const range = (
    <SegmentedControl
      value={state.range === "custom" ? undefined : state.range}
      options={RANGE_PRESETS.map((value) => ({ value, label: t(`usage.toolbar.range.${value}`) }))}
      onChange={(value) => props.onPatch({ range: value })}
      ariaLabel={t("usage.toolbar.rangeLabel")}
      testId="usage-range"
    />
  );
  return (
    <div className={`flex gap-2 py-3 ${narrow ? "flex-col" : "items-center justify-between"}`} data-testid="usage-toolbar" data-layout={narrow ? "narrow" : "wide"}>
      {left}
      <div className={`flex items-center gap-2 ${narrow && filtered ? "justify-between" : "justify-end"}`} data-testid="usage-range-row">
        {narrow && filtered ? clear : null}
        {range}
      </div>
    </div>
  );
}

function profileTitle(profile: OptionProfile, t: TFunction): string {
  return profileName(profile.profileName, profile.deleted, undefined, t);
}

function CredentialMenu(props: { state: UsageState; options: Options | undefined; onPatch: (patch: UsagePatch) => void; className: string; compact: boolean }) {
  const { t } = useTranslation();
  const { state } = props;
  const profiles = props.options?.profiles ?? [];
  const selected = profiles.find((profile) => profile.profileKey === state.profileKey);
  const version = selected?.versions.find((item) => item.credentialVersion === state.credentialVersion);
  let value: string = t("usage.toolbar.all");
  if (state.profileKey !== undefined) {
    value = selected === undefined ? t("usage.names.selectedProfile") : profileTitle(selected, t);
    if (state.credentialVersion !== undefined) {
      value = t("usage.names.profileVersion", {
        profile: value,
        version: credentialVersionLabel(version ?? { credentialVersion: state.credentialVersion, setAt: null }, t),
      });
    }
  }
  const label = t("usage.toolbar.credentialLabel", { value });
  const onValue = (next: string): void => {
    if (next === "") {
      props.onPatch({ profileKey: null, credentialVersion: null, modelKey: null });
      return;
    }
    const [profileKey = "", credentialVersion] = next.split(VERSION_SEPARATOR);
    // A model belongs to one profile: moving to another profile drops the model filter.
    props.onPatch({ profileKey, credentialVersion: credentialVersion ?? null, ...(profileKey === state.profileKey ? {} : { modelKey: null }) });
  };
  return (
    <DropdownMenu.Root>
      <MenuTrigger
        compact={props.compact}
        active={state.profileKey !== undefined}
        title={label}
        ariaLabel={t("usage.toolbar.credentialMenu")}
        className={props.className}
        testId="usage-credential"
      >
        {label}
      </MenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={`${MENU_CONTENT_CLASS} ${MENU_SCROLL_CLASS} min-w-56`} aria-label={t("usage.toolbar.credentialMenu")}>
          <DropdownMenu.RadioGroup value={credentialValue(state)} onValueChange={onValue}>
            <RadioEntry value="">{t("usage.toolbar.all")}</RadioEntry>
            {(["llm", "asr"] as const).map((modality) => {
              const group = profiles.filter((profile) => profile.modality === modality);
              if (group.length === 0) return null;
              return (
                <div key={modality}>
                  <DropdownMenu.Separator className="my-1 h-px bg-line" />
                  <MenuLabel>{t(`usage.toolbar.group.${modality}`)}</MenuLabel>
                  {group.map((profile) => (
                    <div key={profile.profileKey}>
                      <RadioEntry value={profile.profileKey}>{profileTitle(profile, t)}</RadioEntry>
                      {profile.versions.length > 1
                        ? profile.versions.map((item) => (
                            <RadioEntry key={item.credentialVersion} indent value={`${profile.profileKey}${VERSION_SEPARATOR}${item.credentialVersion}`}>
                              {credentialVersionLabel(item, t)}
                            </RadioEntry>
                          ))
                        : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ModelMenu(props: { state: UsageState; options: Options | undefined; onPatch: (patch: UsagePatch) => void; className: string; compact: boolean }) {
  const { t } = useTranslation();
  const { state } = props;
  const profiles = props.options?.profiles ?? [];
  const models = props.options?.models ?? [];
  const nameOf = (profileKey: string): string => {
    const profile = profiles.find((item) => item.profileKey === profileKey);
    return profile === undefined ? t("usage.names.deletedProfile") : profileTitle(profile, t);
  };
  const selected = models.find((model) => model.modelKey === state.modelKey);
  let value: string = t("usage.toolbar.all");
  if (state.modelKey !== undefined) {
    const fallbackId = decodeModelKey(state.modelKey)?.[2] ?? state.modelKey;
    const profile = selected === undefined ? t("usage.names.selectedProfile") : nameOf(selected.profileKey);
    value = t("usage.names.model", { profile, model: selected?.modelId ?? fallbackId });
  }
  const label = t("usage.toolbar.modelLabel", { value });
  // After choosing a credential only that profile's models are on offer.
  const listed = models.filter((model) => state.profileKey === undefined || model.profileKey === state.profileKey);
  const groups = [...new Set(listed.map((model) => model.profileKey))];
  return (
    <DropdownMenu.Root>
      <MenuTrigger
        compact={props.compact}
        active={state.modelKey !== undefined}
        title={label}
        ariaLabel={t("usage.toolbar.modelMenu")}
        className={props.className}
        testId="usage-model"
      >
        {label}
      </MenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={`${MENU_CONTENT_CLASS} ${MENU_SCROLL_CLASS} min-w-56`} aria-label={t("usage.toolbar.modelMenu")}>
          <DropdownMenu.RadioGroup value={state.modelKey ?? ""} onValueChange={(next) => props.onPatch({ modelKey: next === "" ? null : next })}>
            <RadioEntry value="">{t("usage.toolbar.all")}</RadioEntry>
            {groups.map((profileKey) => (
              <div key={profileKey}>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <MenuLabel>{nameOf(profileKey)}</MenuLabel>
                {listed
                  .filter((model) => model.profileKey === profileKey)
                  .map((model) => (
                    <RadioEntry key={model.modelKey} value={model.modelKey}>
                      {model.modelId}
                    </RadioEntry>
                  ))}
              </div>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function CurrencyMenu(props: { currency: PriceCurrency; onChange: (currency: PriceCurrency) => void; compact: boolean }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu.Root>
      <MenuTrigger compact={props.compact} ariaLabel={t("usage.toolbar.currencyMenu")} className="shrink-0" testId="usage-currency">
        {`${currencySymbol(props.currency)} ${t(`usage.currencyNames.${props.currency}`)}`}
      </MenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={MENU_CONTENT_CLASS} aria-label={t("usage.toolbar.currencyMenu")}>
          <DropdownMenu.RadioGroup value={props.currency} onValueChange={(next) => props.onChange(next as PriceCurrency)}>
            {PRICE_CURRENCIES.map((currency) => (
              <RadioEntry key={currency} value={currency} testId={`usage-currency-${currency}`}>
                {t("usage.toolbar.currencyOption", { name: t(`usage.currencyNames.${currency}`), code: currency })}
              </RadioEntry>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
