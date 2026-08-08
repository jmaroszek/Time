import { expect, test, type Page } from "@playwright/test";

const FIXED_NOW = new Date("2026-07-30T17:00:00.000Z");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

async function invocationNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__TIME_DEVICE_TEST__.invocations.map((entry) => entry.command)
  );
}

async function fixtureSettings(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...window.__TIME_DEVICE_TEST__.settings }));
}

test("@workflow onboarding commits consent before starting the tracker", async ({ page }) => {
  await page.goto("/?fixture=onboarding");
  await page.getByRole("button", { name: "Start tracking" }).click();
  await expect(page.getByRole("button", { name: "Insights", exact: true })).toBeVisible();

  const names = await invocationNames(page);
  expect(names.indexOf("set_launch_at_login")).toBeGreaterThan(-1);
  expect(names.indexOf("start_tracker")).toBeGreaterThan(names.indexOf("set_launch_at_login"));
  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("1");
  expect(settings.launch_at_login).toBe("1");
  expect(settings.privacy_onboarding_complete).toBe("1");
});

test("@workflow onboarding Not now never starts or registers tracking", async ({ page }) => {
  await page.goto("/?fixture=onboarding");
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("button", { name: "Insights", exact: true })).toBeVisible();

  const names = await invocationNames(page);
  expect(names).not.toContain("start_tracker");
  const launchCall = await page.evaluate(() =>
    window.__TIME_DEVICE_TEST__.invocations.find(
      (entry) => entry.command === "set_launch_at_login",
    )
  );
  expect(launchCall?.args).toEqual({ enabled: false });
  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
});

test("@workflow onboarding rolls back consent when tracker startup fails", async ({ page }) => {
  await page.goto("/?fixture=onboarding&fail=start_tracker");
  await page.getByRole("button", { name: "Start tracking" }).click();
  await expect(page.getByText("device fixture forced start_tracker failure")).toBeVisible();

  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
  const launchCalls = await page.evaluate(() =>
    window.__TIME_DEVICE_TEST__.invocations
      .filter((entry) => entry.command === "set_launch_at_login")
      .map((entry) => entry.args)
  );
  expect(launchCalls).toEqual([{ enabled: true }, { enabled: false }]);
});

// The welcome panel is the only screen a user reaches by declining at the
// consent step, and the only place tracking can be started without visiting
// Settings. Both of its states are covered here because the quiet failure it
// guards against — tracking that never starts, or starts and then stops for
// good at the next shutdown — produces an app that simply shows nothing.
test("@workflow first run starts tracking, then offers to register startup", async ({ page }) => {
  await page.goto("/?fixture=firstrun&tracker=missing");
  await expect(page.getByText("nothing is being recorded")).toBeVisible();

  await page.getByRole("button", { name: "Start tracking" }).click();
  await expect(page.getByText("Tracking is on")).toBeVisible();

  // Consent has to travel with the launch: a tracker started while consent is
  // "0" runs and records nothing, which reads as a button that did nothing.
  const started = await fixtureSettings(page);
  expect(started.recording_consent).toBe("1");
  // ...but starting must not register startup behind the user's back.
  expect(started.launch_at_login).toBe("0");
  const names = await invocationNames(page);
  expect(names).toContain("start_tracker");
  expect(names).not.toContain("set_launch_at_login");

  await page.getByRole("button", { name: "Start at sign-in" }).click();
  await expect.poll(async () => (await fixtureSettings(page)).launch_at_login).toBe("1");
  const launchCall = await page.evaluate(() =>
    window.__TIME_DEVICE_TEST__.invocations.find(
      (entry) => entry.command === "set_launch_at_login",
    )
  );
  expect(launchCall?.args).toEqual({ enabled: true });
  await expect(page.getByRole("button", { name: "Start at sign-in" })).toHaveCount(0);
});

test("@workflow first run with a live tracker asks for nothing", async ({ page }) => {
  await page.goto("/?fixture=firstrun");
  await expect(page.getByText("Tracking is on")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start tracking" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start at sign-in" })).toHaveCount(0);
  expect(await invocationNames(page)).not.toContain("start_tracker");
});

test("@workflow restore dispatches only after an explicit backup selection", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Restore backup…" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore backup" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore and restart" })).toBeDisabled();
  await dialog.getByRole("radio").first().click();
  await dialog.getByRole("button", { name: "Restore and restart" }).click();
  await expect.poll(() => invocationNames(page)).toContain("restore_database");
});

test("@workflow recording changes preserve visible feedback after startup failure", async ({
  page,
}) => {
  await page.goto("/?fail=set_launch_at_login");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Record activity" }).click();
  await expect(
    page.getByText("device fixture forced set_launch_at_login failure"),
  ).toBeVisible();

  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
  expect(await invocationNames(page)).not.toContain("stop_tracker");
});

test("@workflow missing tracker can be started from its status card", async ({ page }) => {
  await page.goto("/?tracker=missing");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await expect(page.getByText("Tracker not detected")).toBeVisible();
  await page.getByRole("button", { name: "Start tracker" }).click();

  await expect(page.getByText("Tracker is live")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start tracker" })).toHaveCount(0);
  await expect.poll(() => invocationNames(page)).toContain("start_tracker");
});

test("@workflow tracker start failure stays actionable", async ({ page }) => {
  await page.goto("/?tracker=missing&fail=start_tracker");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Start tracker" }).click();

  await expect(page.getByText("device fixture forced start_tracker failure")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start tracker" })).toBeEnabled();
});

test("@workflow tray visibility changes without changing tracker lifecycle", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const trayToggle = page.getByRole("switch", { name: "Show tray icon" });

  await expect(trayToggle).toBeChecked();
  await trayToggle.click();
  await expect.poll(async () => (await fixtureSettings(page)).show_tray_icon).toBe("0");

  const names = await invocationNames(page);
  expect(names).not.toContain("start_tracker");
  expect(names).not.toContain("stop_tracker");
  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("1");
  expect(settings.launch_at_login).toBe("1");
});

test("@workflow support email includes the installed component versions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const advanced = page.locator("#settings-advanced");
  const support = page.locator("#settings-help-feedback");

  await expect(support.getByText("support@trackwithtime.com", { exact: true })).toBeVisible();
  await expect(
    advanced.getByText(
      "Dashboard 0.1.0-device-fixture · Tracker 0.1.0-device-fixture",
      { exact: true },
    ),
  ).toBeVisible();
  await support.getByRole("button", { name: "Email support" }).click();

  const openedUrl = await page.evaluate(() => {
    const call = window.__TIME_DEVICE_TEST__.invocations.find(
      (entry) => entry.command === "plugin:opener|open_url",
    );
    return String(call?.args?.url ?? "");
  });
  const email = new URL(openedUrl);
  expect(`${email.protocol}${email.pathname}`).toBe("mailto:support@trackwithtime.com");
  expect(email.searchParams.get("subject")).toBe("Time support or feedback");
  expect(email.searchParams.get("body")).toContain(
    "Time versions: Dashboard 0.1.0-device-fixture · Tracker 0.1.0-device-fixture",
  );
});

test("@workflow backup and restore failures remain actionable", async ({ page }) => {
  await page.goto("/?fail=backup_database");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "device fixture forced backup_database failure",
  );

  await page.goto("/?fail=restore_database");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Restore backup…" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore backup" });
  await dialog.getByRole("radio").first().click();
  await dialog.getByRole("button", { name: "Restore and restart" }).click();
  await expect(page.getByText("device fixture forced restore_database failure")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore and restart" })).toBeEnabled();
});

test("@workflow activity deletion honors cancellation and refreshes after commit", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const row = page.locator("tbody button").first();
  await row.click();
  await page.getByRole("button", { name: "Delete activity" }).click();
  let dialog = page.getByRole("dialog", { name: "Delete recorded activity?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await invocationNames(page)).not.toContain("delete_activity");

  await page.getByRole("button", { name: "Delete activity" }).click();
  dialog = page.getByRole("dialog", { name: "Delete recorded activity?" });
  await expect(dialog.getByText(/Complete session rows are removed/)).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => invocationNames(page)).toContain("delete_activity");
  await expect.poll(async () =>
    (await invocationNames(page)).filter((name) => name === "fetch_sessions").length
  ).toBeGreaterThan(1);
});

test("@workflow exclusion previews before deleting matching history", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const classification = page.getByRole("combobox", { name: "Classification filter" });
  await classification.click();
  await page.getByRole("option", { name: "Excluded from tracking" }).click();

  await page.getByRole("textbox", { name: "App to exclude" }).fill("code.exe");
  await page.getByText(
    "Also delete matching history, after a count preview",
    { exact: true },
  ).click();
  await page.getByRole("button", { name: "Do not track" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete recorded activity?" });
  await expect(dialog.getByText("code.exe", { exact: true })).toBeVisible();
  expect(await invocationNames(page)).not.toContain("add_tracking_exclusion");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await invocationNames(page)).not.toContain("add_tracking_exclusion");

  await page.getByRole("button", { name: "Do not track" }).click();
  await expect(dialog.getByText("code.exe", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Exclude and delete" }).click();
  await expect(page.getByText(/Excluded code\.exe and deleted/)).toBeVisible();
  const names = await invocationNames(page);
  expect(names.indexOf("preview_tracking_exclusion")).toBeLessThan(
    names.indexOf("add_tracking_exclusion"),
  );
});

test("@workflow all-history erase disables recording before stopping and erasing", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Erase all" }).click();
  const dialog = page.getByRole("dialog", { name: "Erase all recorded history?" });
  await dialog.getByRole("textbox").fill("DELETE");
  // The action closes its own portal and triggers a full metadata refresh.
  // Dispatching the click lets the workflow assertions own that async wait.
  await dialog.getByRole("button", { name: "Erase everything" }).dispatchEvent("click");
  await expect(page.getByText(/Securely erased \d+ recorded sessions/)).toBeVisible();

  const calls = await page.evaluate(() => window.__TIME_DEVICE_TEST__.invocations);
  const names = calls.map((entry) => entry.command);
  const settingAt = (key: string) => calls.findIndex(
    (entry) => entry.command === "db_execute"
      && Array.isArray(entry.args?.values)
      && entry.args.values[0] === key,
  );
  const consentAt = settingAt("recording_consent");
  const launchSettingAt = settingAt("launch_at_login");
  const registrationAt = names.lastIndexOf("set_launch_at_login");
  const stopAt = names.lastIndexOf("stop_tracker");
  const eraseAt = names.lastIndexOf("erase_history");
  expect(launchSettingAt).toBeGreaterThan(consentAt);
  expect(registrationAt).toBeGreaterThan(launchSettingAt);
  expect(stopAt).toBeGreaterThan(registrationAt);
  expect(eraseAt).toBeGreaterThan(stopAt);
  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
  await expect.poll(() =>
    page.evaluate(() => window.__TIME_DEVICE_TEST__.sessionCount())
  ).toBe(0);
});

test("@workflow the panel's Manage row offers rename alongside the hover pencil", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.locator("tbody tr button").first().click();

  const panel = page.getByRole("complementary", { name: /^Activity details/ });
  // The pencil only exists on hover, so the Manage row is the findable way in.
  // Exact, or this also matches the pencil's "Rename Explorer".
  await panel.getByRole("button", { name: "Rename", exact: true }).click();

  // It drives the same editor the pencil does — on the heading, not in place.
  const field = panel.getByRole("textbox", { name: /^Rename / });
  await expect(field).toBeFocused();
  await field.fill("File Manager");
  await field.press("Enter");

  await expect(panel.getByRole("heading", { name: "File Manager" })).toBeVisible();
  await expect.poll(async () => JSON.parse((await fixtureSettings(page)).process_aliases)).toMatchObject({
    "explorer.exe": "File Manager",
  });
});

test("@workflow Top Apps totals processes that share a display name as one row", async ({
  page,
}) => {
  await page.goto("/?fixture=merged");
  // Both builds are aliased "Time". Before rows were keyed by display name these
  // were two rows, identically labelled, each holding half the total.
  const rows = page.locator(".top-app-row").filter({ hasText: "Time" });
  await expect(rows).toHaveCount(1);

  // The row carries no editor — naming an app belongs to its Activity panel —
  // but it still says which processes it stands for.
  await expect(rows.getByTitle("time-tracker.exe, time.exe")).toBeVisible();
  await expect(rows.getByRole("textbox")).toHaveCount(0);
  await rows.first().dblclick();
  await expect(rows.getByRole("textbox")).toHaveCount(0);
});

// The update control is the whole update feature as far as a user is concerned:
// if it does not appear, nobody updates, and if it moves the header when it
// appears or expands, it breaks the one rule this header has — the date-range
// picker sits at the far end of it and must not wander.
test("@workflow the update control appears only when a version is waiting", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Update to/ })).toHaveCount(0);

  await page.goto("/?update=available");
  await expect(page.getByRole("button", { name: "Update to 0.2.0" })).toBeVisible();
});

test("@workflow the update control names its version without moving the header", async ({
  page,
}) => {
  await page.goto("/?update=available");
  const control = page.getByRole("button", { name: "Update to 0.2.0" });
  await expect(control).toBeVisible();

  const tabs = page.getByRole("button", { name: "Settings", exact: true });
  const before = await tabs.boundingBox();
  await control.hover();
  // The label is revealed over the header, not within it: the button grows and
  // the tabs beside it do not.
  await expect(control).toContainText("Update to 0.2.0");
  expect(await tabs.boundingBox()).toEqual(before);

  // Reachable without a mouse, which is the whole reason the label is tied to
  // focus as well as hover.
  await control.focus();
  await expect(control).toBeFocused();
});

test("@workflow installing an update reports progress and cannot be started twice", async ({
  page,
}) => {
  await page.goto("/?update=available");
  await page.getByRole("button", { name: "Update to 0.2.0" }).click();

  const downloading = page.getByRole("button", { name: /^Downloading update/ });
  await expect(downloading).toBeDisabled();

  await page.evaluate(() =>
    window.__TIME_DEVICE_EVENTS__.emit("update://progress", { downloaded: 25, total: 100 }),
  );
  await expect(page.getByRole("button", { name: "Downloading update… 25%" })).toBeVisible();

  const calls = await page.evaluate(() =>
    window.__TIME_DEVICE_TEST__.invocations.filter((entry) => entry.command === "install_update")
      .length,
  );
  expect(calls).toBe(1);
});
