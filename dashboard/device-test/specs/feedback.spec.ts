import { expect, test, type Page } from "@playwright/test";

const FIXED_NOW = new Date("2026-07-30T17:00:00.000Z");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

async function fixtureSettings(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...window.__TIME_DEVICE_TEST__.settings }));
}

/** Every URL the app handed to the shell, in order. */
async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__TIME_DEVICE_TEST__.invocations
      .filter((entry) => entry.command === "plugin:opener|open_url")
      .map((entry) => String((entry.args as { url?: string } | undefined)?.url ?? "")),
  );
}

const ASK = "Are you satisfied with Time?";

test("@workflow no feedback prompt reaches a reader who has not earned it", async ({ page }) => {
  // The default fixture clears every gate but the active-day floor, which is
  // the one that separates a used install from an old one.
  await page.goto("/");
  await expect(page.getByText(ASK)).toHaveCount(0);
});

test("@workflow a happy reader is routed to a draft, not to a form", async ({ page }) => {
  await page.goto("/?feedback=app");
  await expect(page.getByText(ASK)).toBeVisible();

  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByText("Would you like to leave a review?")).toBeVisible();
  await expect(page.getByText(/Time collects reviews by email/)).toBeVisible();
  await page.getByRole("button", { name: "Yes", exact: true }).click();

  const opened = await openedUrls(page);
  expect(opened).toHaveLength(1);
  // Nothing is transmitted: the reader gets a draft in their own mail client
  // and sends it themselves, which is what keeps the webview off the network.
  expect(opened[0]).toContain("mailto:support@trackwithtime.com");
  expect(opened[0]).toContain("subject=Time%20feedback%3A%20what%20is%20working");

  const settings = await fixtureSettings(page);
  expect(settings.app_feedback_prompt_state).toBe("done");
  expect(Number(settings.feedback_prompt_last_shown)).toBeGreaterThan(0);
  await expect(page.getByText(ASK)).toHaveCount(0);
});

test("@workflow an unhappy reader is asked what is wrong instead", async ({ page }) => {
  await page.goto("/?feedback=app");
  await page.getByRole("button", { name: "No", exact: true }).click();
  await expect(page.getByText("Would you like to tell me what is wrong?")).toBeVisible();
  // Exact, because "Yes" now labels the first step's affirmative too: a loose
  // match would find the wrong one the moment this panel grows another button.
  await page.getByRole("button", { name: "Yes", exact: true }).click();

  const opened = await openedUrls(page);
  expect(opened[0]).toContain("subject=Time%20feedback%3A%20what%20is%20not%20working");
  expect((await fixtureSettings(page)).app_feedback_prompt_state).toBe("done");
});

test("@workflow Ask later leaves a stamp rather than an answer", async ({ page }) => {
  await page.goto("/?feedback=app");
  await page.getByRole("button", { name: "Ask later", exact: true }).click();
  await expect(page.getByText(ASK)).toHaveCount(0);

  const settings = await fixtureSettings(page);
  // A timestamp, not "done": the question comes back once the snooze expires.
  expect(settings.app_feedback_prompt_state).not.toBe("done");
  expect(Number(settings.app_feedback_prompt_state)).toBeGreaterThan(0);
  expect(settings.feedback_prompts_enabled).toBe("1");
});

test("@workflow Don't ask again silences every question, not just this one", async ({ page }) => {
  await page.goto("/?feedback=app");
  await page.getByRole("button", { name: "Don't ask again", exact: true }).click();
  await expect(page.getByText(ASK)).toHaveCount(0);

  const settings = await fixtureSettings(page);
  // The switch Settings shows, so the decision stays visible and reversible.
  expect(settings.feedback_prompts_enabled).toBe("0");
  expect(settings.app_feedback_prompt_state).toBe("");
});

test("@workflow the extension ask sends the reader to their own store", async ({ page }) => {
  await page.goto("/?feedback=extension");
  await expect(page.getByText("Are you satisfied with the Time Web Extension?")).toBeVisible();

  await page.getByRole("button", { name: "Yes, it works", exact: true }).click();
  await expect(page.getByText(/Reviews live on the Chrome Web Store/)).toBeVisible();
  await page.getByRole("button", { name: "Yes", exact: true }).click();

  const opened = await openedUrls(page);
  expect(opened[0]).toContain("chromewebstore.google.com");
  expect((await fixtureSettings(page)).extension_review_prompt_state).toBe("done");
});

test("@workflow an unhappy extension reader gets support, not a review page", async ({ page }) => {
  await page.goto("/?feedback=extension");
  await page.getByRole("button", { name: "No, it doesn't", exact: true }).click();
  await page.getByRole("button", { name: "Yes", exact: true }).click();

  const opened = await openedUrls(page);
  expect(opened[0]).toContain("mailto:support@trackwithtime.com");
  expect(opened[0]).not.toContain("chromewebstore");
});

test("@workflow a stopped tracker outranks the ask entirely", async ({ page }) => {
  // The invariant the whole arrangement exists to keep: one interruption at a
  // time, and never a request for a favour over a tracker that is not working.
  await page.goto("/?feedback=app&tracker=missing");
  await expect(page.getByText(ASK)).toHaveCount(0);
});

test("@workflow the Settings switch reports what Don't ask again turned off", async ({ page }) => {
  await page.goto("/?feedback=app");
  await page.getByRole("button", { name: "Don't ask again", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const toggle = page.getByRole("switch", { name: "Ask for feedback occasionally" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});


test("@workflow the review ask names the store serving this reader's browser", async ({ page }) => {
  // The store is resolved from the default browser's ProgId, so this copy is
  // wrong for most readers if it is ever hard-coded. Firefox is the case that
  // catches it: Edge and Brave both legitimately resolve to the Chrome Web
  // Store, so only this one fails when the lookup is bypassed.
  await page.goto("/?feedback=extension&browser=firefox");
  await page.getByRole("button", { name: "Yes, it works", exact: true }).click();

  await expect(page.getByText(/Reviews live on the Firefox Add-ons page/)).toBeVisible();
  await expect(page.getByText(/Chrome Web Store/)).toHaveCount(0);

  await page.getByRole("button", { name: "Yes", exact: true }).click();
  expect((await openedUrls(page))[0]).toContain("addons.mozilla.org");
});
