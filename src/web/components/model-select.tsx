import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AsrServiceMark, LlmModelMark } from "../models/model-mark.tsx";
import { Select, type SelectOption, type SelectSize } from "../ui/select.tsx";

/** One model in the list, under the caller's own value encoding. */
export interface ModelSelectEntry {
  /** The caller's value for this model; must not be "" (that stands for none). */
  value: string;
  profileName: string;
  /** Tells profiles apart when two share a name; the name alone when absent. */
  profileKey?: string | undefined;
  modelId: string;
  /** LLM: the profile's service preset; transcription: the service. Picks the fallback or the mark. */
  service?: string | undefined;
}

/**
 * Stands for "none chosen" inside the menu: Radix reads the empty string as no value at all and
 * would show the placeholder instead of the "none" entry. Never reaches the caller.
 */
const NONE = "\u0000none";

/**
 * A model picker over the user's profiles in the app's menu style. The list is grouped by
 * profile (no heading with a single profile) and each entry shows the vendor mark and the model
 * name; once chosen, the trigger shows the mark and "profile · model", the profile name giving
 * way first when space runs out. Type-ahead goes by model name.
 *
 * `value` and `onChange` speak the caller's encoding with "" for none, exactly like the native
 * `<select>` this replaces. With `noneLabel` the first entry chooses none; without it, an unset
 * value shows `placeholder`. A value that is not (or no longer) listed stays shown as its own
 * entry, labelled by `current`, rather than silently becoming another model; with
 * `current.value` that entry is kept for the named value whatever is selected.
 */
export function ModelSelect(props: {
  kind: "llm" | "asr";
  entries: readonly ModelSelectEntry[];
  value: string;
  onChange: (value: string) => void;
  noneLabel?: string | undefined;
  placeholder?: string | undefined;
  /** How to show a value missing from `entries`; defaults to the value itself. */
  current?: { label: string; modelId?: string | undefined; service?: string | undefined; value?: string | undefined } | undefined;
  id?: string | undefined;
  ariaLabel?: string | undefined;
  describedBy?: string | undefined;
  testId?: string | undefined;
  disabled?: boolean | undefined;
  size?: SelectSize | undefined;
  width?: "fill" | "content" | undefined;
  className?: string | undefined;
}) {
  const iconSize = props.size === "sm" ? 14 : 16;
  const mark = (modelId: string | undefined, service: string | undefined) =>
    props.kind === "llm" ? (
      <LlmModelMark modelId={modelId ?? ""} presetId={service} size={iconSize} />
    ) : (
      <AsrServiceMark provider={service} size={iconSize} />
    );
  const groupOf = (entry: ModelSelectEntry): string => entry.profileKey ?? entry.profileName;
  const grouped = new Set(props.entries.map(groupOf)).size > 1;
  // The kept value is the current one, or the binding named by `current.value`, which stays
  // listed even after the user picks another model so they can switch back to it.
  const kept = props.current?.value ?? props.value;
  const listed = kept === "" || props.entries.some((entry) => entry.value === kept);

  const options: Array<SelectOption<string>> = [];
  if (props.noneLabel !== undefined) {
    options.push({ value: NONE, label: props.noneLabel, dividerAfter: props.entries.length > 0 || !listed });
  }
  if (!listed) {
    const current = props.current ?? { label: kept };
    const icon = mark(current.modelId, current.service);
    options.push({
      value: kept,
      label: current.label,
      icon,
      valueContent: <Chosen key={kept} icon={icon} model={current.label} />,
      valueTitle: current.label,
      dividerAfter: props.entries.length > 0,
    });
  }
  for (const entry of props.entries) {
    const icon = mark(entry.modelId, entry.service);
    options.push({
      value: entry.value,
      label: entry.modelId,
      icon,
      ...(grouped ? { group: entry.profileName, groupKey: groupOf(entry) } : {}),
      // Keyed by the choice: another model starts measured afresh with its profile name shown.
      valueContent: <Chosen key={entry.value} icon={icon} profile={entry.profileName} model={entry.modelId} />,
      valueTitle: `${entry.profileName} · ${entry.modelId}`,
    });
  }

  const selected = props.value === "" ? (props.noneLabel !== undefined ? NONE : undefined) : props.value;
  return (
    <Select
      id={props.id}
      value={selected}
      options={options}
      onChange={(next) => props.onChange(next === NONE ? "" : next)}
      placeholder={props.placeholder ?? ""}
      disabled={props.disabled}
      ariaLabel={props.ariaLabel}
      describedBy={props.describedBy}
      testId={props.testId}
      size={props.size}
      width={props.width}
      menuWidth="fit"
      className={props.className}
    />
  );
}

/** Below this much room (the dot included) the profile name is left out rather than cut to a character or two. */
const PROFILE_MIN_PX = 64;

/**
 * The closed trigger: mark, then "profile · model". The model name keeps its room; the profile
 * name gives way first, cut with an ellipsis, and is left out (with its dot) once only a sliver
 * of it would show. The trigger's title always carries the full name.
 */
function Chosen(props: { icon: ReactNode; profile?: string; model: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const model = useRef<HTMLSpanElement>(null);
  const [profileShown, setProfileShown] = useState(true);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || props.profile === undefined || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      // No layout (e.g. not rendered yet): keep the name.
      if (element.clientWidth === 0) return;
      setProfileShown(element.clientWidth - (model.current?.scrollWidth ?? 0) >= PROFILE_MIN_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.profile, props.model]);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {props.icon}
      <span ref={box} className="flex min-w-0 flex-1">
        {props.profile === undefined ? null : (
          <span className="flex min-w-0 whitespace-pre" hidden={!profileShown}>
            <span className="min-w-0 truncate">{props.profile}</span>
            <span className="shrink-0">{" · "}</span>
          </span>
        )}
        {/* While the profile shows, the model fits whole (that is when it shows), so only the profile gives way. */}
        <span ref={model} className={props.profile !== undefined && profileShown ? "shrink-0" : "min-w-0 truncate"}>
          {props.model}
        </span>
      </span>
    </span>
  );
}
