import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminPage } from "../../../../src/web/pages/admin/admin-page.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const ADMIN = { userId: "a1", role: "admin", mode: "server", mustChangePassword: false };
const USERS = {
  users: [
    { id: "a1", username: "admin", role: "admin", status: "active", mustChangePassword: false, createdAt: 1 },
    { id: "u2", username: "bob", role: "user", status: "active", displayName: "Bob", storageLimitGB: 5, mustChangePassword: true, createdAt: 2 },
  ],
};

function admin(route: string) {
  return renderApp(<AdminPage />, { route, path: "/admin/:section", mode: "server" });
}

describe("AdminPage", () => {
  it("shows no admin area to a non-admin or in local mode", async () => {
    const { calls } = mockApi({ "GET /api/auth/me": { body: { ...ADMIN, role: "user" } } });
    const { unmount } = admin("/admin/users");
    expect(await screen.findByText("只有服务器管理员可以进入系统管理")).toBeTruthy();
    expect(calls.some((call) => call.path.startsWith("/api/admin"))).toBe(false);
    unmount();
    mockApi({ "GET /api/auth/me": { body: { ...ADMIN, mode: "local" } } });
    admin("/admin/users");
    expect(await screen.findByText("只有服务器管理员可以进入系统管理")).toBeTruthy();
  });

  it("lists users and suspends, resets and deletes through the admin endpoints", async () => {
    const { calls } = mockApi({
      "GET /api/auth/me": { body: ADMIN },
      "GET /api/admin/users": { body: USERS },
      "PATCH /api/admin/users/u2": { body: USERS.users[1] },
      "POST /api/admin/users/u2/reset-password": { status: 204 },
      "DELETE /api/admin/users/u2": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.tasks_still_running", retryDisposition: "never", userMessage: "该用户的任务尚未结束，请稍后重试" } },
      },
    });
    admin("/admin/users");
    const row = (await screen.findByText("bob")).closest("tr") as HTMLElement;
    expect(within(row).getByText("待改密")).toBeTruthy();
    expect(within(row).getByText("5 GB")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "暂停" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ status: "suspended" }));

    fireEvent.click(within(row).getByRole("button", { name: "重置密码" }));
    fireEvent.change(await screen.findByLabelText("新密码"), { target: { value: "another-long-password" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "重置密码" }));
    await waitFor(() => expect(calls.find((call) => call.path === "/api/admin/users/u2/reset-password")?.body).toEqual({ newPassword: "another-long-password" }));

    fireEvent.click(within(row).getByRole("button", { name: "删除" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "删除" }));
    expect(await screen.findByText("该用户的任务尚未结束，请稍后重试")).toBeTruthy();
  });

  it("folds status, quota and creation time under the username on a narrow list", async () => {
    mockApi({ "GET /api/auth/me": { body: ADMIN }, "GET /api/admin/users": { body: USERS } });
    admin("/admin/users");
    const row = (await screen.findByText("bob")).closest("tr") as HTMLElement;
    expect(screen.getByTestId("admin-users").parentElement?.className).toBe("@container");
    for (const name of ["状态", "配额", "创建时间"]) {
      expect(screen.getByRole("columnheader", { name }).className.split(" "), name).toEqual(expect.arrayContaining(["hidden", "@2xl:table-cell"]));
    }
    const meta = within(row).getByTestId("admin-user-meta");
    expect(meta.className.split(" ")).toContain("@2xl:hidden");
    expect(meta.textContent).toMatch(/^正常 · 5 GB · \S/u);
  });

  it("edits the quota and clears it with null", async () => {
    const { calls } = mockApi({
      "GET /api/auth/me": { body: ADMIN },
      "GET /api/admin/users": { body: USERS },
      "PATCH /api/admin/users/u2": { body: USERS.users[1] },
    });
    admin("/admin/users");
    const row = (await screen.findByText("bob")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    fireEvent.change(await screen.findByLabelText("存储配额（GB，留空 = 使用全局空间）"), { target: { value: "" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ storageLimitGB: null }));
  });

  it("creates a user", async () => {
    const { calls } = mockApi({
      "GET /api/auth/me": { body: ADMIN },
      "GET /api/admin/users": { body: USERS },
      "POST /api/admin/users": { status: 201, body: USERS.users[1] },
    });
    admin("/admin/users");
    fireEvent.click(await screen.findByRole("button", { name: "新建用户" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("用户名"), { target: { value: "carol" } });
    fireEvent.change(within(dialog).getByLabelText("初始密码"), { target: { value: "initial-password-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "新建" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST" && call.path === "/api/admin/users")?.body).toEqual({
        username: "carol",
        password: "initial-password-1",
        role: "user",
      }),
    );
  });

  it("replaces the network allowlist and shows a rejected entry", async () => {
    const { calls } = mockApi({
      "GET /api/auth/me": { body: ADMIN },
      "GET /api/admin/network-allowlist": { body: { origins: ["http://10.0.0.5:8080"] } },
      "PUT /api/admin/network-allowlist": {
        status: 400,
        body: { error: { class: "invalid_request", code: "invalid_request.allowlist_entry", retryDisposition: "never", userMessage: "白名单条目须为精确的 scheme://host[:port]" } },
      },
    });
    admin("/admin/network");
    const box = (await screen.findByLabelText(/允许的 origin/)) as HTMLTextAreaElement;
    expect(box.value).toBe("http://10.0.0.5:8080");
    fireEvent.change(box, { target: { value: "http://10.0.0.5:8080\n\n  http://10.*  \n" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("白名单条目须为精确的 scheme://host[:port]")).toBeTruthy();
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ origins: ["http://10.0.0.5:8080", "http://10.*"] });
  });

  it("resets all credentials only after confirmation", async () => {
    const { calls } = mockApi({
      "GET /api/auth/me": { body: ADMIN },
      "POST /api/admin/credentials/reset": { body: { credentialsResetAt: 1_790_000_000_000 } },
    });
    admin("/admin/credentials");
    fireEvent.click(await screen.findByRole("button", { name: "重置全部凭据" }));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "重置全部凭据" }));
    expect(await screen.findByText(/已于 .* 重置全部凭据/)).toBeTruthy();
  });

  it("explains the data directory and the free-space floor without the media cache, which a server has not", async () => {
    mockApi({
      "GET /api/auth/me": { body: ADMIN },
      "GET /api/instance-settings": {
        body: { concurrencyPipeline: 2, maxDataGB: 50, lowWaterFreeGB: 10, lowWaterFreeRatio: 0, uploadRetentionDefault: "keep", updatedAt: 0, envOverridden: [] },
      },
    });
    admin("/admin/instance");
    const explainer = await screen.findByTestId("disk-explainer");
    expect(Array.from(explainer.querySelectorAll("p"), (line) => line.textContent)).toEqual([
      "数据目录存放资料库、上传的原始文件、日志和处理中的临时文件等，「数据目录上限」计算的就是它的大小。",
      "最低剩余空间和最低剩余比例一起决定每块磁盘至少要留出的空闲：必须保留的空闲 = max(最低剩余空间，最低剩余比例 × 磁盘总容量)，即两者取较大值。比例为 0 时只看最低剩余空间，例如 1 TB 的磁盘，最低剩余空间 10 GB、比例 0.2 时需保留 200 GB，比例为 0 时需保留 10 GB。空闲低于这个值时不再开始新任务。",
    ]);
    expect(explainer.textContent).not.toContain("缓存");
  });

  it("shows storage per user by username", async () => {
    mockApi({
      "GET /api/auth/me": { body: ADMIN },
      "GET /api/admin/users": { body: USERS },
      "GET /api/admin/storage": { body: { totalBytes: 100 * 1024 ** 3, freeBytes: 60 * 1024 ** 3, usedBytes: 40 * 1024 ** 3, users: [{ userId: "u2", usedBytes: 1536, storageLimitGB: 5 }] } },
    });
    admin("/admin/storage");
    expect(await screen.findByText("bob")).toBeTruthy();
    expect(screen.getByText("1.5 KB")).toBeTruthy();
    expect(screen.getByText("100.0 GB")).toBeTruthy();
  });
});
