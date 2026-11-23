import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PASSWORD_MIN_LEN } from "../../../src/shared/defaults.ts";
import { ChangePasswordForm } from "../../../src/web/auth/change-password-form.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const WRONG_CURRENT = {
  status: 400,
  body: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "请求参数有误：currentPassword" } },
};

/** The text of everything an element's `aria-describedby` points to, as a screen reader reads it with the element. */
function descriptionOf(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function fillNew(): void {
  fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password-123" } });
  fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "new-password-123" } });
}

describe("ChangePasswordForm", () => {
  it("moves focus to the current password field when the server refuses it, so the reason is read out", async () => {
    mockApi({ "POST /api/auth/change-password": WRONG_CURRENT });
    renderApp(<ChangePasswordForm submitLabel="修改密码" onDone={vi.fn()} />, { mode: "server" });
    const current = screen.getByLabelText("当前密码");
    fireEvent.change(current, { target: { value: "not-the-password" } });
    fillNew();
    const submit = screen.getByRole("button", { name: "修改密码" });
    submit.focus();
    fireEvent.click(submit);
    await waitFor(() => expect(document.activeElement).toBe(current));
    expect(current.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionOf(current)).toContain("当前密码不正确");
  });

  it("moves focus to the field at fault for its own checks on sending, without a request", async () => {
    const { calls } = mockApi({});
    renderApp(<ChangePasswordForm submitLabel="修改密码" onDone={vi.fn()} />, { mode: "server" });
    const next = screen.getByLabelText("新密码");
    const confirm = screen.getByLabelText("确认新密码");
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old-password-123" } });
    fireEvent.change(next, { target: { value: "short" } });
    fireEvent.change(confirm, { target: { value: "short" } });
    const submit = screen.getByRole("button", { name: "修改密码" });
    submit.focus();
    fireEvent.click(submit);
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(next.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionOf(next)).toContain(`新密码至少 ${PASSWORD_MIN_LEN} 个字符`);
    fireEvent.change(next, { target: { value: "new-password-123" } });
    fireEvent.change(confirm, { target: { value: "other-password-123" } });
    submit.focus();
    fireEvent.click(submit);
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionOf(confirm)).toContain("两次输入的新密码不一致");
    expect(calls).toEqual([]);
  });

  it("announces a refused password the login step already verified, having no field to point at", async () => {
    mockApi({ "POST /api/auth/change-password": WRONG_CURRENT });
    renderApp(<ChangePasswordForm currentPassword="from-login" submitLabel="设置新密码" onDone={vi.fn()} />, { mode: "server" });
    expect(screen.queryByLabelText("当前密码")).toBeNull();
    fillNew();
    fireEvent.click(screen.getByRole("button", { name: "设置新密码" }));
    expect((await screen.findByRole("alert")).textContent).toContain("当前密码不正确");
  });
});
