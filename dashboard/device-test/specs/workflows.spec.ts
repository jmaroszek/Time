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

async function lifecycleActions(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__TIME_DEVICE_TEST__.invocations
      .filter((entry) => entry.command === "run_tracking_lifecycle")
      .map((entry) => String(entry.args?.action && (entry.args.action as { action?: string }).action)),
  );
}

test("@workflow onboarding commits consent before starting the tracker", async ({ page }) => {
  await page.goto("/?fixture=onboarding");
  await page.getByRole("button", { name: "Start tracking" }).click();
  await expect(page.getByRole("button", { name: "Insights", exact: true })).toBeVisible();

  const names = await invocationNames(page);
  expect(names).toContain("run_tracking_lifecycle");
  expect(await lifecycleActions(page)).toContain("complete_onboarding");
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
  expect(await lifecycleActions(page)).toEqual(["complete_onboarding"]);
  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
});

test("@workflow onboarding rolls back consent when tracker startup fails", async ({ page }) => {
  await page.goto("/?fixture=onboarding&fail=run_tracking_lifecycle");
  await page.getByRole("button", { name: "Start tracking" }).click();
  await expect(page.getByText("device fixture forced run_tracking_lifecycle failure")).toBeVisible();

  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
  expect(settings.privacy_onboarding_complete).toBe("0");
  expect(await lifecycleActions(page)).toEqual(["complete_onboarding"]);
});

// The first-run panel is the only screen a user reaches by declining at the
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
  expect(await lifecycleActions(page)).toContain("set_recording");

  await page.getByRole("button", { name: "Start at sign-in" }).click();
  await expect.poll(async () => (await fixtureSettings(page)).launch_at_login).toBe("1");
  expect(await lifecycleActions(page)).toContain("set_startup");
  await expect(page.getByRole("button", { name: "Start at sign-in" })).toHaveCount(0);
});

// A running process is not consent. The tracker stamps its health before any
// recording gate is applied, so it beats on happily after "Not now" — and
// reading that stamp as "tracking is on" told a reader Time was recording in
// the background while it was storing nothing at all. Consent decides what this
// panel says; liveness only decides whether starting is still needed.
test("@workflow a live tracker without consent still offers to start recording", async ({
  page,
}) => {
  await page.goto("/?fixture=firstrun");
  await expect(page.getByText("nothing is being recorded")).toBeVisible();
  await expect(page.getByText("Tracking is on")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start tracking" })).toBeVisible();
  // Offering is not doing: nothing may start until the reader asks.
  expect(await lifecycleActions(page)).toEqual([]);
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
  await page.goto("/?fail=run_tracking_lifecycle");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Record activity" }).click();
  await expect(
    page.getByText("device fixture forced run_tracking_lifecycle failure"),
  ).toBeVisible();

  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
  expect(await lifecycleActions(page)).toContain("set_recording");
});

test("@workflow missing tracker can be started from its status card", async ({ page }) => {
  await page.goto("/?tracker=missing");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await expect(page.getByText("Tracker not detected")).toBeVisible();
  await page.getByRole("button", { name: "Start tracker" }).click();

  await expect(page.getByText("Tracker is live")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start tracker" })).toHaveCount(0);
  await expect.poll(() => lifecycleActions(page)).toContain("ensure_started");
});

// Starting and resuming are different operations on different state, and the
// status card offers whichever one the tracker actually needs. Resume is a
// native action so clearing pause keys and starting cannot race a stale status
// read.
test("@workflow a paused tracker is resumed, not started, from its status card", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // Establish liveness before pausing. The fixture's health stamp is a fixed
  // timestamp that ages in real time, so a test that assumed it was still fresh
  // would start failing on a slow run rather than on a real defect.
  await expect(page.getByText("Tracker is live")).toBeVisible();
  await page.evaluate(() => {
    const settings = window.__TIME_DEVICE_TEST__.settings;
    settings.tracking_paused = "1";
    settings.tracking_paused_until = "0";
    settings.tracker_health_heartbeat = String(Math.floor(Date.now() / 1000));
  });
  // Pause is read on mount and then every 15s, because the tray writes it
  // outside every path that refreshes the dashboard. Leave and return rather
  // than waiting out that cycle.
  await page.getByRole("button", { name: "Insights", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await expect(page.getByText("Tracking paused")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start tracker" })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume now" }).click();

  // Both keys move together, or the pause is over and is not.
  await expect.poll(async () => await fixtureSettings(page)).toMatchObject({
    tracking_paused: "0",
    tracking_paused_until: "0",
  });
  await expect(page.getByText("Tracker is live")).toBeVisible();
  expect(await lifecycleActions(page)).toContain("resume");
});

test("@workflow resuming a pause that outlived the tracker also starts it", async ({ page }) => {
  await page.goto("/?tracker=missing");
  await page.evaluate(() => {
    window.__TIME_DEVICE_TEST__.settings.tracking_paused = "1";
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  // A pause the reader chose outranks liveness in the label.
  await expect(page.getByText("Tracking paused")).toBeVisible();
  await page.getByRole("button", { name: "Resume now" }).click();

  // Resuming means "record again", not "clear a flag and leave a second broken
  // state for the reader to find".
  await expect.poll(() => lifecycleActions(page)).toContain("resume");
  await expect(page.getByText("Tracker is live")).toBeVisible();
});

test("@workflow tracker start failure stays actionable", async ({ page }) => {
  await page.goto("/?tracker=missing&fail=run_tracking_lifecycle");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Start tracker" }).click();

  await expect(page.getByText("device fixture forced run_tracking_lifecycle failure")).toBeVisible();
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
  expect(await lifecycleActions(page)).toEqual([]);
  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("1");
  expect(settings.launch_at_login).toBe("1");
});

test("@workflow scheduling restores sign-in startup and saves an overnight window", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const startup = page.getByRole("switch", { name: "Start at Windows sign-in" });
  await startup.click();
  await expect.poll(async () => (await fixtureSettings(page)).launch_at_login).toBe("0");

  await page.getByRole("switch", { name: "Only record on a schedule" }).click();
  await expect.poll(async () => (await fixtureSettings(page)).tracking_schedule_enabled).toBe("1");
  await expect.poll(async () => (await fixtureSettings(page)).launch_at_login).toBe("1");
  await expect(startup).toBeDisabled();
  await expect(page.getByText("Required while scheduling is on")).toBeVisible();

  await page.getByLabel("Saturday").click();
  await expect.poll(async () => (await fixtureSettings(page)).tracking_schedule_days).toBe("0,1,2,3,4,5");
  await page.getByRole("textbox", { name: "From", exact: true }).fill("22:00");
  await page.getByRole("textbox", { name: "Until", exact: true }).fill("06:00");
  await expect.poll(async () => (await fixtureSettings(page)).tracking_schedule_start_minute).toBe("1320");
  await expect.poll(async () => (await fixtureSettings(page)).tracking_schedule_end_minute).toBe("360");
  await expect(page.getByText("Runs overnight into the next day.")).toBeVisible();

  expect(await lifecycleActions(page)).toEqual([
    "set_startup",
    "set_schedule",
    "set_schedule",
    "set_schedule",
    "set_schedule",
  ]);
});

test("@workflow lifecycle busy state gates dependent settings and data mutations", async ({
  page,
}) => {
  await page.goto("/?lifecycleDelay=500");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Record activity" }).click();

  // The native operation is intentionally held open by the device fixture.
  // Every dependent control, including Data actions owned by child sections,
  // stays disabled until that one lifecycle promise settles.
  await expect(page.getByRole("switch", { name: "Start at Windows sign-in" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Only record on a schedule" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Restore defaults", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Back up now" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Erase all" })).toBeDisabled();

  await expect(page.getByRole("switch", { name: "Record activity" })).toHaveAttribute("aria-checked", "false");
});

test("@workflow a banner lifecycle action gates Settings and Data while in flight", async ({
  page,
}) => {
  await page.goto("/?tracker=missing&lifecycleDelay=1000");
  await expect(page.getByRole("button", { name: "Start tracking" })).toBeVisible();
  await page.getByRole("button", { name: "Start tracking" }).click();

  // The request originates in an App-level banner, then the reader moves to
  // Settings while it is still pending. The same transport-owned busy store
  // must gate controls in the newly mounted Settings tree.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Record activity" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Start at Windows sign-in" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start tracker" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Back up now" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Erase all" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Record activity" })).toBeEnabled({ timeout: 3000 });
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
  const backupDialog = page.getByRole("dialog", { name: "Save backup" });
  await backupDialog.getByRole("button", { name: "Save backup" }).click();
  await expect(backupDialog.getByRole("alert")).toContainText(
    "device fixture forced backup_database failure",
  );
  await expect(backupDialog.getByRole("button", { name: "Save backup" })).toBeEnabled();

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
  expect(names).toContain("run_tracking_lifecycle");
  expect(await lifecycleActions(page)).toContain("secure_erase");
  const settings = await fixtureSettings(page);
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
  await expect.poll(() =>
    page.evaluate(() => window.__TIME_DEVICE_TEST__.sessionCount())
  ).toBe(0);
});

test("@workflow restore defaults uses the native lifecycle contract", async ({ page }) => {
  await page.goto("/?theme=dark");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Restore default settings?" });
  await dialog.getByRole("button", { name: "Restore defaults" }).click();
  await expect(page.getByRole("button", { name: "Defaults restored" })).toBeVisible();

  expect(await lifecycleActions(page)).toContain("restore_defaults");
  const settings = await fixtureSettings(page);
  expect(settings.theme).toBe("system");
  expect(settings.recording_consent).toBe("0");
  expect(settings.launch_at_login).toBe("0");
  expect(settings.tracking_schedule_enabled).toBe("0");
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

test("@workflow Insights switches from ranked apps to exact-host websites", async ({ page }) => {
  await page.goto("/");
  const topCount = page.getByRole("combobox", { name: "How many apps to list" });
  const kind = page.getByRole("combobox", { name: "Ranked activity type" });
  await expect(topCount).toContainText("Top 10");
  await expect(kind).toContainText("Apps");

  const [countBox, kindBox] = await Promise.all([topCount.boundingBox(), kind.boundingBox()]);
  expect(countBox).not.toBeNull();
  expect(kindBox).not.toBeNull();
  expect(countBox!.x).toBeLessThan(kindBox!.x);

  await kind.click();
  await page.getByRole("option", { name: "Websites", exact: true }).click();

  await expect(page.getByText("Top Websites", { exact: true })).toBeVisible();
  await expect(page.getByTitle("docs.example.com")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "How many websites to list" })).toContainText(
    "Top 10",
  );
});

test("@workflow new-user presets explain when longer durations show the same history", async ({
  page,
}) => {
  await page.goto("/?fixture=newuser");
  const preset = page.getByRole("combobox", { name: "Date range preset" });
  await preset.click();
  await expect(page.getByRole("option", { name: "Week", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Month", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Quarter", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Year", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Month", exact: true }).click();
  await expect(page.getByText(
    "Only 3 days recorded, so Month currently shows all available history.",
    { exact: true },
  )).toBeVisible();
});

test("@workflow every Insights canvas has a meaningful accessible description", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("canvas").first()).toBeVisible();
  const canvasCount = await page.locator("canvas").count();
  const charts = page.locator('[data-insights-chart="true"]');
  const descriptions = await charts.evaluateAll((items) =>
    items.map((chart) => chart.getAttribute("aria-label")),
  );
  expect(descriptions.length).toBe(canvasCount);
  expect(descriptions.length).toBeGreaterThanOrEqual(2);
  expect(descriptions.every((description) =>
    description !== null
    && description.length > 40
    && /selected|complete/.test(description)
    && /showing|show|broken down/.test(description)
  )).toBe(true);
});

test("@workflow configured Goal pace shares the missing-data states", async ({ page }) => {
  for (const [url, note] of [
    ["/?fixture=firstrun&goal=20", "Nothing recorded yet"],
    ["/?fixture=unclassified", "Nothing classified yet"],
  ] as const) {
    await page.goto(url);
    const card = page.getByLabel(/^Goal pace\./).locator("xpath=../..");
    await expect(card).toContainText("—");
    await expect(card).toContainText(note);
    await expect(card).not.toContainText(/of \d+h/);
  }
});

test("@workflow website tracking confirmation appears only for newly arriving data", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByText("Website tracking is working.")).toHaveCount(0);

  await page.goto("/?browser=signal");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByText("Website tracking is working.")).toBeVisible();
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await expect.poll(async () => (await fixtureSettings(page)).website_signal_seen).toBe("1");
});

test("@workflow website-rule hint leads through the row Classification control", async ({
  page,
}) => {
  await page.goto("/?browser=classified");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const showWebsites = page.getByRole("button", { name: "Show websites", exact: true });
  await expect(showWebsites).toBeVisible();
  await showWebsites.click();
  await expect(page.getByRole("combobox", { name: "Activity type" })).toContainText("Websites");
  await page.locator("tbody button").first().click();
  await expect(
    page.getByRole("complementary").getByText("Classification", { exact: true }),
  ).toBeVisible();
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

/**
 * The switch reports what was asked for; Windows holds what is true. They are
 * reconciled at every launch, so the only way they still disagree is a repair
 * that could not be made — and that is the state in which the switch alone says
 * something false: on, over no registration, with nothing starting at the next
 * sign-in and no symptom until days of recording are missing.
 */
test("@workflow a startup registration Windows no longer holds is reported and repairable", async ({
  page,
}) => {
  await page.goto("/?startup=lost");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const warning = page.getByText("Windows has no startup entry for Time");
  await expect(warning).toBeVisible();

  // The switch still reads on, because the setting is on. That is not a bug to
  // fix by flipping it: the reader asked for this and the registration is what
  // failed, so the honest report is both facts rather than a silent correction.
  const toggle = page.getByRole("switch", { name: "Start at Windows sign-in" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Try again" }).click();

  // Repair goes through the same action the switch does, which is only capable
  // of fixing this because it no longer returns early on a database that
  // already says on.
  await expect(warning).toBeHidden();
  expect(await lifecycleActions(page)).toContain("set_startup");
});

test("@workflow a tray icon the tracker could not create is reported", async ({ page }) => {
  await page.goto("/?tray=off");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await expect(
    page.getByText("The tracker could not create a tray icon on this system"),
  ).toBeVisible();

  // Turning the setting off retires the warning immediately rather than waiting
  // for the tracker's next poll to agree: nothing is wrong once nothing is asked
  // for, and a warning that lingers past its cause teaches people to ignore it.
  await page.getByRole("switch", { name: "Show tray icon" }).click();
  await expect(
    page.getByText("The tracker could not create a tray icon on this system"),
  ).toBeHidden();
});
