import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NativeSelect } from "../../../src/web/ui/native-select.tsx";

const select = (name: string): HTMLSelectElement => screen.getByRole<HTMLSelectElement>("combobox", { name });

const OPTIONS = (
  <>
    <option value="a">甲</option>
    <option value="b">乙</option>
    <option value="c">丙</option>
  </>
);

describe("NativeSelect", () => {
  it("hands the ref the native select", () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <NativeSelect ref={ref} aria-label="字段">
        {OPTIONS}
      </NativeSelect>,
    );
    expect(ref.current).toBe(select("字段"));
    expect(ref.current?.tagName).toBe("SELECT");
  });

  it("is controlled by value and reports changes with the native event", () => {
    const seen: string[] = [];
    function Controlled() {
      const [value, setValue] = useState("a");
      return (
        <NativeSelect
          aria-label="字段"
          value={value}
          onChange={(event) => {
            seen.push(event.target.value);
            setValue(event.target.value);
          }}
        >
          {OPTIONS}
        </NativeSelect>
      );
    }
    render(<Controlled />);
    expect(select("字段").value).toBe("a");
    fireEvent.change(select("字段"), { target: { value: "c" } });
    expect(select("字段").value).toBe("c");
    expect(seen).toEqual(["c"]);
  });

  it("starts from defaultValue and returns to it on form reset", () => {
    render(
      <form data-testid="form">
        <NativeSelect aria-label="字段" name="field" defaultValue="b">
          {OPTIONS}
        </NativeSelect>
      </form>,
    );
    expect(select("字段").value).toBe("b");
    fireEvent.change(select("字段"), { target: { value: "c" } });
    expect(new FormData(screen.getByTestId<HTMLFormElement>("form")).get("field")).toBe("c");
    screen.getByTestId<HTMLFormElement>("form").reset();
    expect(select("字段").value).toBe("b");
  });

  it("passes disabled through", () => {
    const onChange = vi.fn();
    render(
      <NativeSelect aria-label="字段" disabled onChange={onChange}>
        {OPTIONS}
      </NativeSelect>,
    );
    expect(select("字段").disabled).toBe(true);
  });

  it("marks an invalid value with aria-invalid and the danger border", () => {
    const { rerender } = render(
      <NativeSelect aria-label="字段" invalid aria-describedby="field-error">
        {OPTIONS}
      </NativeSelect>,
    );
    expect(select("字段").getAttribute("aria-invalid")).toBe("true");
    expect(select("字段").getAttribute("aria-describedby")).toBe("field-error");
    expect(select("字段").className).toContain("aria-[invalid=true]:border-danger");
    rerender(<NativeSelect aria-label="字段">{OPTIONS}</NativeSelect>);
    expect(select("字段").hasAttribute("aria-invalid")).toBe(false);
  });

  it("passes data-testid, aria-* and id through and appends className", () => {
    render(
      <>
        <label htmlFor="picked">选择</label>
        <NativeSelect id="picked" data-testid="picked-select" aria-required="true" required className="w-44" size="sm">
          {OPTIONS}
        </NativeSelect>
      </>,
    );
    const element = screen.getByTestId<HTMLSelectElement>("picked-select");
    expect(element).toBe(select("选择"));
    expect(element.getAttribute("aria-required")).toBe("true");
    expect(element.required).toBe(true);
    expect(element.className).toMatch(/ w-44$/);
    expect(element.className).toContain("h-7");
    // The visible-rows attribute is never set: `size` is the control height here.
    expect(element.hasAttribute("size")).toBe(false);
  });

  it("defaults to the form input height", () => {
    render(<NativeSelect aria-label="字段">{OPTIONS}</NativeSelect>);
    expect(select("字段").className).toContain("h-9");
  });
});
