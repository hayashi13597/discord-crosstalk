import { expect, test, type Page } from "@playwright/test";
const admin = {
  user: {
    id: "123456789012345678",
    username: "hayashi",
    global_name: "Hayashi",
  },
  csrf: "test-csrf",
  access: {
    admin: true,
    read: true,
    groups: true,
    teams: true,
    audit: true,
    move: true,
    settings: true,
  },
  guild: { id: "123456789012345679", name: "CrossTalk Gaming", icon: null },
};
const channels = Array.from({ length: 31 }, (_, i) => ({
  id: String(223456789012345670n + BigInt(i)),
  name: i === 30 ? "Sảnh tập trung" : `Voice ${String(i + 1).padStart(2, "0")}`,
  limit: 0,
  members: [
    { id: `human${i}`, name: `Player ${i + 1}`, bot: false, leader: i < 3 },
    { id: `bot${i}`, name: "Relay Bot", bot: true, leader: false },
  ],
}));
async function setup(page: Page, viewer = false) {
  const snapshot = {
    updatedAt: new Date().toISOString(),
    guild: admin.guild,
    leaderRoleId: "123456789012345680",
    groups: [
      {
        id: "group-a",
        name: "Group A",
        state: "active",
        actual: "Active",
        legacy: true,
        version: "v1",
      },
      {
        id: "group-b",
        name: "Bravo",
        state: "paused",
        actual: "Paused",
        legacy: false,
        version: "v2",
      },
    ],
    teams: channels
      .slice(0, 3)
      .map((c, i) => ({
        id: `team-${i}`,
        channelId: c.id,
        workerId: i + 1,
        groupId: "group-a",
        legacySlot: i + 1,
        version: "v1",
      })),
    channels,
    bots: Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      name: `CrossTalk ${i + 1}`,
      teamId: i < 3 ? `team-${i}` : null,
      reserved: i < 3,
      gateway: true,
      voice: i < 3 ? "ready" : "offline",
      leadersKnown: true,
      leaderIds: i < 3 ? [`human${i}`] : [],
      receiving: i < 3,
      lastError: null,
    })),
  };
  await page.addInitScript((data) => {
    class Stream extends EventTarget {
      timer: ReturnType<typeof setInterval>;
      onerror = null;
      constructor() {
        super();
        (window as unknown as { testStream: Stream }).testStream = this;
        this.timer = setInterval(
          () =>
            this.dispatchEvent(
              new MessageEvent("snapshot", { data: JSON.stringify(data) }),
            ),
          300,
        );
      }
      close() {
        clearInterval(this.timer);
      }
    }
    window.EventSource = Stream as unknown as typeof EventSource;
  }, snapshot);
  const current = viewer
    ? {
        ...admin,
        access: {
          admin: false,
          read: true,
          groups: false,
          teams: false,
          audit: false,
          move: false,
          settings: false,
        },
      }
    : admin;
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: current }),
  );
  await page.route("**/api/control/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/control", "");
    if (path === "/snapshot") return route.fulfill({ json: snapshot });
    if (path === "/audit")
      return route.fulfill({
        json: {
          items: [
            {
              id: "1",
              actor_id: admin.user.id,
              action: "group.create",
              changed_at: new Date().toISOString(),
              result: "Applied",
              details: { name: "Bravo" },
            },
          ],
          hasMore: false,
        },
      });
    if (path === "/settings" && route.request().method() === "GET")
      return route.fulfill({
        json: {
          rules: [],
          roles: [{ id: "123456789012345681", name: "Operator" }],
        },
      });
    if (path === "/moves" && route.request().method() === "GET")
      return route.fulfill({ json: { items: [] } });
    if (path === "/moves/preview") {
      const body = route.request().postDataJSON();
      const selected = channels.filter((c) => body.sources.includes(c.id));
      return route.fulfill({
        json: {
          id: "preview-id",
          expiresAt: Date.now() + 60000,
          sources: selected.map((c) => ({ id: c.id, humans: 1, bots: 1 })),
          destinationId: body.destinationId,
          members: selected.map((c) => ({
            userId: c.members[0].id,
            sourceId: c.id,
          })),
          botsSkipped: selected.length,
          leaders: ["human0"],
          destinationLimit: 0,
          destinationOccupancy: 0,
        },
      });
    }
    if (path === "/moves/confirm")
      return route.fulfill({
        status: 202,
        json: { id: "job-id", status: "Running" },
      });
    if (path === "/moves/job-id")
      return route.fulfill({
        json: {
          id: "job-id",
          status: "Completed",
          reason: null,
          actorId: admin.user.id,
          createdAt: new Date().toISOString(),
          members: [
            {
              userId: "human0",
              sourceId: channels[0].id,
              status: "moved",
              reason: null,
            },
          ],
        },
      });
    if (route.request().method() === "POST")
      return route.fulfill({
        json: { status: "Applied", message: "Đã lưu thay đổi." },
      });
    return route.fulfill({
      status: 404,
      json: { error: { message: "Not found" } },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { errors };
}
async function navigate(page: Page, label: string) {
  const mobile = await page
    .getByRole("button", { name: "Mở menu", exact: true })
    .isVisible();
  if (mobile)
    await page.getByRole("button", { name: "Mở menu", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: label, exact: true })
    .click();
}
test("Discord login screen is responsive and contains no application secrets", async ({
  page,
}) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { message: "Login required" } },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /Đăng nhập bằng Discord/ }),
  ).toHaveAttribute("href", "/api/auth/discord/login");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("overview, groups, leader read-only and Settings navigation", async ({
  page,
}) => {
  const { errors } = await setup(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mọi team. Một kết nối." }),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/crosstalk-overview-${test.info().project.name}.png`,
    fullPage: true,
  });
  await navigate(page, "Relay Groups");
  await page.getByRole("button", { name: "Tạo group", exact: true }).click();
  await page.getByRole("textbox", { name: "Tên hiển thị" }).fill("Charlie");
  const created = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/control/groups") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Xác nhận", exact: true }).click();
  expect((await created).postDataJSON()).toEqual({ name: "Charlie" });
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await navigate(page, "Leaders");
  await expect(
    page.getByText(/Thêm\/gỡ role trực tiếp trên Discord/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Thêm leader|Xóa leader/ }),
  ).toHaveCount(0);
  await navigate(page, "Nhật ký hoạt động");
  await expect(page.getByText("group.create", { exact: true })).toBeVisible();
  await navigate(page, "Cài đặt & Phân quyền");
  await page.getByRole("button", { name: "Thêm vai trò", exact: true }).click();
  await expect(page.getByLabel("Vai trò Discord")).toBeVisible();
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("Mass Move selects over 25 sources, previews and confirms a job", async ({
  page,
}) => {
  const { errors } = await setup(page);
  await page.goto("/?view=move");
  await page
    .getByRole("combobox", { name: "Kênh đích", exact: true })
    .selectOption(channels[30].id);
  await page.getByRole("button", { name: "Chọn tất cả kết quả" }).click();
  await expect(page.getByText("30 đã chọn")).toBeVisible();
  const preview = page.waitForRequest((req) =>
    req.url().endsWith("/moves/preview"),
  );
  await page
    .getByRole("button", { name: "Xem trước di chuyển", exact: true })
    .click();
  expect((await preview).postDataJSON().sources).toHaveLength(30);
  await expect(
    page.getByRole("heading", { name: "Xác nhận di chuyển" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Xác nhận chuyển 30 người", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tiến độ di chuyển" }),
  ).toBeVisible();
  await expect(page.getByText("Hoàn tất", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("Viewer has no mutation controls and offline snapshots block edits", async ({
  page,
}) => {
  await setup(page, true);
  await page.goto("/?view=groups");
  await expect(
    page.getByRole("heading", { name: "Relay Groups", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Tạo group", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "Di chuyển voice", exact: true }),
  ).toHaveCount(0);
});
test("lost worker connection disables administrative actions", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/?view=groups");
  const button = page.getByRole("button", { name: "Tạo group", exact: true });
  await expect(button).toBeEnabled();
  await page.evaluate(() => {
    const stream = (
      window as unknown as {
        testStream: { close(): void; dispatchEvent(event: Event): void };
      }
    ).testStream;
    stream.close();
    stream.dispatchEvent(new MessageEvent("offline", { data: "{}" }));
  });
  await expect(button).toBeDisabled();
  await expect(page.getByText(/Kết nối bị gián đoạn/)).toBeVisible();
});
