import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AsrProfileDto } from "../../../src/shared/dto/asr-profile.ts";
import type { AsrModelRefDto } from "../../../src/shared/dto/model-ref.ts";
import { AsrModelSelect } from "../../../src/web/components/asr-model-select.tsx";
import { ModelSelect, type ModelSelectEntry } from "../../../src/web/components/model-select.tsx";
import { chooseOption, openSelect, selectGroups, selectOptionNames, stubSelectLayout } from "../../fixtures/web/select.ts";

beforeEach(stubSelectLayout);

const ENTRIES: ModelSelectEntry[] = [
  { value: '["p1","gpt-6-sol"]', profileName: "Auth2API", modelId: "gpt-6-sol", service: "custom" },
  { value: '["p1","claude-opus-5-5"]', profileName: "Auth2API", modelId: "claude-opus-5-5", service: "custom" },
  { value: '["p2","deepseek-chat"]', profileName: "DeepSeek", modelId: "deepseek-chat", service: "deepseek" },
  { value: '["p3","deepseek-chat"]', profileName: "百炼", modelId: "deepseek-chat", service: "qwen" },
  { value: '["p3","relay-x"]', profileName: "百炼", modelId: "relay-x", service: "qwen" },
];

function Picker(props: { entries?: ModelSelectEntry[]; initial?: string | undefined; onChange?: (value: string) => void; noneLabel?: string; placeholder?: string; current?: { label: string; modelId?: string; value?: string } }) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <ModelSelect
      kind="llm"
      ariaLabel="模型"
      entries={props.entries ?? ENTRIES}
      value={value}
      noneLabel={props.noneLabel}
      placeholder={props.placeholder}
      current={props.current}
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
    />
  );
}

const trigger = (): HTMLElement => screen.getByRole("combobox", { name: "模型" });
const marks = (element: HTMLElement): Array<string | null> => [...element.querySelectorAll("svg[data-vendor-icon]")].map((icon) => icon.getAttribute("data-vendor-icon"));

describe("ModelSelect", () => {
  it("lists only model names under profile headings, in the given order, each with its vendor mark", async () => {
    render(<Picker noneLabel="未设置" />);
    expect(await selectGroups(trigger())).toEqual([
      { heading: "Auth2API", options: ["gpt-6-sol", "claude-opus-5-5"] },
      { heading: "DeepSeek", options: ["deepseek-chat"] },
      { heading: "百炼", options: ["deepseek-chat", "relay-x"] },
    ]);
    const listbox = await openSelect(trigger());
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["未设置", "gpt-6-sol", "claude-opus-5-5", "deepseek-chat", "deepseek-chat", "relay-x"]);
    // By model name first, then the profile's service, else neutral.
    expect(options.slice(1).map((option) => marks(option)[0])).toEqual(["openai", "claude", "deepseek", "deepseek", "qwen"]);
    expect(marks(options[0] as HTMLElement)).toEqual([]);
  });

  it("shows the mark and 'profile · model' on the trigger once chosen, with the full name as its title", async () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} placeholder="请选择模型" />);
    expect(trigger().textContent).toBe("请选择模型");
    await chooseOption(trigger(), "deepseek-chat", "百炼");
    expect(onChange).toHaveBeenLastCalledWith('["p3","deepseek-chat"]');
    expect(trigger().textContent).toBe("百炼 · deepseek-chat");
    expect(trigger().getAttribute("title")).toBe("百炼 · deepseek-chat");
    expect(marks(trigger())).toEqual(["deepseek"]);
  });

  it("keeps two profiles of the same name apart", async () => {
    const twins: ModelSelectEntry[] = [
      { value: "a", profileName: "ElevenLabs", profileKey: "p1", modelId: "scribe_v2" },
      { value: "b", profileName: "ElevenLabs", profileKey: "p2", modelId: "scribe_v2" },
    ];
    render(<Picker entries={twins} />);
    expect(await selectGroups(trigger())).toEqual([
      { heading: "ElevenLabs", options: ["scribe_v2"] },
      { heading: "ElevenLabs", options: ["scribe_v2"] },
    ]);
  });

  it("drops the heading when every model comes from one profile", async () => {
    render(<Picker entries={ENTRIES.slice(0, 2)} />);
    expect(await selectGroups(trigger())).toEqual([]);
    expect(await selectOptionNames(trigger())).toEqual(["gpt-6-sol", "claude-opus-5-5"]);
  });

  it("chooses none through its own entry and reports it as an empty value", async () => {
    const onChange = vi.fn();
    render(<Picker noneLabel="未设置" initial={ENTRIES[0]?.value} onChange={onChange} />);
    expect(trigger().textContent).toBe("Auth2API · gpt-6-sol");
    await chooseOption(trigger(), "未设置");
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(trigger().textContent).toBe("未设置");
    await chooseOption(trigger(), "gpt-6-sol");
    expect(onChange).toHaveBeenLastCalledWith(ENTRIES[0]?.value);
  });

  it("keeps a value that is no longer listed as its own entry instead of switching to another model", async () => {
    render(<Picker initial='["gone","glm-5"]' current={{ label: "配置已删除 · glm-5", modelId: "glm-5" }} />);
    expect(trigger().textContent).toBe("配置已删除 · glm-5");
    expect(marks(trigger())).toEqual(["glm"]);
    const names = await selectOptionNames(trigger());
    expect(names[0]).toBe("配置已删除 · glm-5");
    expect(names).toHaveLength(ENTRIES.length + 1);
  });

  it("keeps a named binding listed after another model is picked, so it can be chosen again", async () => {
    const onChange = vi.fn();
    render(<Picker initial='["gone","glm-5"]' current={{ label: "配置已删除 · glm-5", modelId: "glm-5", value: '["gone","glm-5"]' }} onChange={onChange} />);
    await chooseOption(trigger(), "gpt-6-sol");
    expect(trigger().textContent).toBe("Auth2API · gpt-6-sol");
    await chooseOption(trigger(), "配置已删除 · glm-5");
    expect(onChange).toHaveBeenLastCalledWith('["gone","glm-5"]');
    expect(trigger().textContent).toBe("配置已删除 · glm-5");
  });

  it("handles a long list from the keyboard: type-ahead by model name, arrows, Enter", async () => {
    const many: ModelSelectEntry[] = Array.from({ length: 50 }, (_, index) => ({
      value: `m${index}`,
      profileName: `Profile ${Math.floor(index / 10)}`,
      modelId: index === 37 ? "kimi-k3" : `model-${String(index).padStart(2, "0")}`,
    }));
    const onChange = vi.fn();
    render(<Picker entries={many} onChange={onChange} />);
    expect(await selectOptionNames(trigger())).toHaveLength(50);
    const listbox = await openSelect(trigger());
    fireEvent.keyDown(listbox, { key: "k" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("kimi-k3"));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("model-38"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("m38");
    expect(trigger().textContent).toBe("Profile 3 · model-38");
  });

  it("uses the small icon on a small trigger", () => {
    render(<ModelSelect kind="llm" ariaLabel="模型" entries={ENTRIES} value={ENTRIES[0]?.value ?? ""} onChange={() => undefined} size="sm" />);
    expect(trigger().querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(trigger().className).toContain("h-7");
  });
});

describe("AsrModelSelect", () => {
  const PROFILES = [
    { id: "a1", name: "ElevenLabs", provider: "elevenlabs", models: [{ modelId: "scribe_v2", available: true }, { modelId: "scribe_v0", available: false }] },
    { id: "a2", name: "百炼", provider: "dashscope", models: [{ modelId: "paraformer-v2", available: true }] },
  ] as unknown as AsrProfileDto[];

  function AsrPicker(props: { initial?: AsrModelRefDto; onChange?: (ref: AsrModelRefDto | undefined) => void; currentLabel?: string | undefined }) {
    const [value, setValue] = useState(props.initial);
    return (
      <AsrModelSelect
        profiles={PROFILES}
        label="转录模型"
        noneLabel="暂不选择"
        value={value}
        currentLabel={props.currentLabel}
        onChange={(ref) => {
          setValue(ref);
          props.onChange?.(ref);
        }}
      />
    );
  }

  const asrTrigger = (): HTMLElement => screen.getByRole("combobox", { name: "转录模型" });

  it("lists the available models by service with their marks, after the none entry", async () => {
    render(<AsrPicker />);
    expect(asrTrigger().textContent).toBe("暂不选择");
    expect(await selectOptionNames(asrTrigger())).toEqual(["暂不选择", "scribe_v2", "paraformer-v2"]);
    const listbox = await openSelect(asrTrigger());
    expect(marks(listbox)).toEqual(["elevenlabs", "dashscope"]);
  });

  it("reports the same reference the native select did, and none as undefined", async () => {
    const onChange = vi.fn();
    render(<AsrPicker onChange={onChange} />);
    await chooseOption(asrTrigger(), "paraformer-v2");
    expect(onChange).toHaveBeenLastCalledWith({ asrProfileId: "a2", modelId: "paraformer-v2" });
    expect(asrTrigger().textContent).toBe("百炼 · paraformer-v2");
    await chooseOption(asrTrigger(), "暂不选择");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps a bound model listed after another is picked, so it can be chosen again", async () => {
    const bound = { asrProfileId: "gone", modelId: "scribe_v1" };
    function Rerun() {
      const [value, setValue] = useState<AsrModelRefDto | undefined>(bound);
      return <AsrModelSelect profiles={PROFILES} label="转录模型" value={value} bound={bound} currentLabel="ElevenLabs · scribe_v1（配置已删除）" currentProvider="elevenlabs" onChange={setValue} />;
    }
    render(<Rerun />);
    expect(marks(asrTrigger())).toEqual(["elevenlabs"]);
    await chooseOption(asrTrigger(), "paraformer-v2");
    expect(asrTrigger().textContent).toBe("百炼 · paraformer-v2");
    await chooseOption(asrTrigger(), "ElevenLabs · scribe_v1（配置已删除）");
    expect(asrTrigger().textContent).toBe("ElevenLabs · scribe_v1（配置已删除）");
  });

  it("keeps an unavailable current model shown under its given label and service mark", () => {
    render(<AsrPicker initial={{ asrProfileId: "a1", modelId: "scribe_v0" }} currentLabel="ElevenLabs · scribe_v0（已不可用）" />);
    expect(asrTrigger().textContent).toBe("ElevenLabs · scribe_v0（已不可用）");
    expect(marks(asrTrigger())).toEqual(["elevenlabs"]);
  });
});
