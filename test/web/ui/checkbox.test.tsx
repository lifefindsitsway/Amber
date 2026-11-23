import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox, Radio, RadioCard } from "../../../src/web/ui/checkbox.tsx";

const box = (name: string): HTMLInputElement => screen.getByRole<HTMLInputElement>("checkbox", { name });
const radio = (name: string): HTMLInputElement => screen.getByRole<HTMLInputElement>("radio", { name });

describe("Checkbox", () => {
  it("is a controlled native check box whose onChange gets the native event", () => {
    const seen: Array<{ checked: boolean; native: boolean }> = [];
    function Controlled() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox
          aria-label="全选"
          checked={checked}
          data-testid="all"
          onChange={(event) => {
            seen.push({ checked: event.target.checked, native: event.nativeEvent instanceof Event });
            setChecked(event.target.checked);
          }}
        />
      );
    }
    render(<Controlled />);
    expect(box("全选").type).toBe("checkbox");
    expect(screen.getByTestId("all")).toBe(box("全选"));
    fireEvent.click(box("全选"));
    expect(box("全选").checked).toBe(true);
    fireEvent.click(box("全选"));
    expect(box("全选").checked).toBe(false);
    expect(seen).toEqual([
      { checked: true, native: true },
      { checked: false, native: true },
    ]);
  });

  it("works uncontrolled and returns to defaultChecked on form reset", () => {
    render(
      <form data-testid="form">
        <Checkbox aria-label="记住" defaultChecked name="remember" />
      </form>,
    );
    fireEvent.click(box("记住"));
    expect(box("记住").checked).toBe(false);
    (screen.getByTestId("form") as HTMLFormElement).reset();
    expect(box("记住").checked).toBe(true);
  });

  it("sets the indeterminate DOM property from the prop and follows its changes", () => {
    const { rerender } = render(<Checkbox aria-label="部分" indeterminate checked={false} onChange={() => undefined} />);
    expect(box("部分").indeterminate).toBe(true);
    rerender(<Checkbox aria-label="部分" indeterminate={false} checked={false} onChange={() => undefined} />);
    expect(box("部分").indeterminate).toBe(false);
    rerender(<Checkbox aria-label="部分" indeterminate checked={false} onChange={() => undefined} />);
    expect(box("部分").indeterminate).toBe(true);
  });

  it("hands an object ref the input and leaves indeterminate to it when the prop is absent", () => {
    // The way a page sets the mixed state of a "select this page" box itself.
    function Page(props: { some: boolean }) {
      const ref = useRef<HTMLInputElement>(null);
      useEffect(() => {
        if (ref.current !== null) ref.current.indeterminate = props.some;
      });
      return <Checkbox ref={ref} aria-label="本页" checked={false} onChange={() => undefined} />;
    }
    const { rerender } = render(<Page some />);
    expect(box("本页").indeterminate).toBe(true);
    rerender(<Page some={false} />);
    expect(box("本页").indeterminate).toBe(false);
    rerender(<Page some />);
    expect(box("本页").indeterminate).toBe(true);
  });

  it("hands a callback ref the input, and keeps applying the prop through it", () => {
    const nodes: Array<HTMLInputElement | null> = [];
    const callback = vi.fn((node: HTMLInputElement | null) => {
      nodes.push(node);
    });
    const { unmount } = render(<Checkbox ref={callback} aria-label="回调" indeterminate />);
    expect(nodes[0]).toBe(box("回调"));
    expect(box("回调").indeterminate).toBe(true);
    unmount();
    expect(nodes.at(-1)).toBeNull();
  });

  it("passes disabled through to the native box and dims its label", () => {
    // The DOM under test still dispatches clicks to disabled inputs, so only the state is checked.
    render(
      <Checkbox disabled labelClassName="extra" data-testid="disabled-box">
        禁用
      </Checkbox>,
    );
    expect(box("禁用").disabled).toBe(true);
    expect(screen.getByTestId("disabled-box").closest("label")?.className).toContain("has-disabled:opacity-60");
  });

  it("is labelled by its children, and a click on the label text toggles it", () => {
    render(<Checkbox data-testid="with-label">显示已删除</Checkbox>);
    const input = box("显示已删除");
    expect(input).toBe(screen.getByTestId("with-label"));
    fireEvent.click(screen.getByText("显示已删除"));
    expect(input.checked).toBe(true);
  });

  it("can be labelled by a separate label element", () => {
    render(
      <>
        <label htmlFor="separate">单独的标签</label>
        <Checkbox id="separate" />
      </>,
    );
    fireEvent.click(screen.getByText("单独的标签"));
    expect(box("单独的标签").checked).toBe(true);
  });
});

describe("Radio", () => {
  function Group(props: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState("a");
    return (
      <div>
        {[
          ["a", "甲"],
          ["b", "乙"],
          ["c", "丙"],
        ].map(([key, label]) => (
          <Radio
            key={key}
            name="group"
            value={key}
            checked={value === key}
            onChange={(event) => {
              setValue(event.target.value);
              props.onChange?.(event.target.value);
            }}
          >
            {label}
          </Radio>
        ))}
      </div>
    );
  }

  it("selects with a click and moves with the arrow keys, wrapping around", () => {
    const onChange = vi.fn();
    render(<Group onChange={onChange} />);
    expect(radio("甲").checked).toBe(true);
    fireEvent.click(radio("丙"));
    expect(radio("丙").checked).toBe(true);
    radio("丙").focus();
    fireEvent.keyDown(radio("丙"), { key: "ArrowDown" });
    expect(radio("甲").checked).toBe(true);
    expect(document.activeElement).toBe(radio("甲"));
    fireEvent.keyDown(radio("甲"), { key: "ArrowUp" });
    expect(radio("丙").checked).toBe(true);
    fireEvent.keyDown(radio("丙"), { key: "ArrowLeft" });
    expect(radio("乙").checked).toBe(true);
    expect(onChange.mock.calls.map((call) => call[0])).toEqual(["c", "a", "c", "b"]);
  });

  it("skips disabled radios", () => {
    render(
      <div>
        <Radio name="g2" defaultChecked>
          一
        </Radio>
        <Radio name="g2" disabled>
          二
        </Radio>
        <Radio name="g2">三</Radio>
      </div>,
    );
    radio("一").focus();
    fireEvent.keyDown(radio("一"), { key: "ArrowRight" });
    expect(radio("三").checked).toBe(true);
    expect(radio("二").checked).toBe(false);
  });
});

describe("RadioCard", () => {
  function Cards() {
    const [value, setValue] = useState("fast");
    return (
      <div role="radiogroup" aria-label="模式">
        <RadioCard name="mode" value="fast" title="快速" description="只转写，不区分说话人" checked={value === "fast"} onChange={(event) => setValue(event.target.value)} testId="card-fast" />
        <RadioCard name="mode" value="full" title="完整" description="转写并区分说话人" checked={value === "full"} onChange={(event) => setValue(event.target.value)} testId="card-full">
          <span data-testid="extra">额外内容</span>
        </RadioCard>
      </div>
    );
  }

  it("is named by its title, described by its description, and selected by a click anywhere on the card", () => {
    render(<Cards />);
    const full = radio("完整");
    expect(full.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.getElementById(full.getAttribute("aria-describedby") as string)?.textContent).toBe("转写并区分说话人");
    expect(screen.getByTestId("card-full").contains(screen.getByTestId("extra"))).toBe(true);
    fireEvent.click(screen.getByTestId("extra"));
    expect(full.checked).toBe(true);
    expect(radio("快速").checked).toBe(false);
  });

  it("moves through the group with the arrow keys", () => {
    render(<Cards />);
    radio("快速").focus();
    fireEvent.keyDown(radio("快速"), { key: "ArrowDown" });
    expect(radio("完整").checked).toBe(true);
    expect(document.activeElement).toBe(radio("完整"));
    fireEvent.keyDown(radio("完整"), { key: "ArrowDown" });
    expect(radio("快速").checked).toBe(true);
  });
});
