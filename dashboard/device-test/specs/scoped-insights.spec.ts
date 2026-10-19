import { expect, test, type Locator, type Page } from "@playwright/test";

const FIXED_NOW = new Date("2026-07-30T17:00:00.000Z");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

/** The figure a metric tile shows, found through its label's accessible name.
 *  Insights and Activity draw their tiles differently, but in both the label
 *  sits two levels below the tile and the figure is the tile's mt-1 line. */
function tile(scope: Page | Locator, label: string): Locator {
  return scope
    .getByLabel(new RegExp(`^${label}\\.`))
    .locator("xpath=../..")
    .locator(":scope > p.mt-1");
}

/** The header control names the subject, so its name is the page's subject. */
const subject = (page: Page) => page.getByRole("button", { name: /^Narrow Insights/ });
const narrowedTo = (page: Page, name: string) =>
  expect(subject(page)).toHaveAccessibleName(`Narrow Insights: ${name}`);
const showAll = (page: Page) => page.getByRole("button", { name: "Show all activity" }).click();

// Every fixture day has the same shape: Explorer from 12:00 to 13:01, Slack
// from 13:00 for 54 minutes, then nothing until Chrome at 14:00. The default
// range is the last seven days, so Slack is one 54-minute run on each of them.

test("@workflow a Top Apps row narrows Insights to that app, and back out", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Slack", exact: true }).click();

  await narrowedTo(page, "Slack");
  await expect(tile(page, "Time in range")).toContainText("6h 18m");
  await expect(tile(page, "Days used")).toHaveText(/^7\s*of 7$/);
  await expect(tile(page, "Runs per day")).toHaveText("1");
  await expect(tile(page, "Typical run")).toHaveText("54m");
  await expect(page.getByRole("button", { name: "Product Design — Time", exact: true })).toBeVisible();
  // All of Slack's time is one classification, so there is nothing to stack by.
  await expect(page.getByRole("combobox", { name: "Stack bars by" })).toHaveCount(0);

  await showAll(page);
  await narrowedTo(page, "All activity");
  await expect(page.getByRole("button", { name: "Show all activity" })).toHaveCount(0);
  await expect(page.getByText("Top Apps", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Daily productive time\./)).toBeVisible();
});

test("@workflow an app opened from a category stays inside that category", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Narrow Insights/ }).click();
  await page.getByRole("combobox", { name: "Find an app, website, or category" }).fill("focus");
  await page.getByRole("option", { name: /^Focus/ }).click();

  await narrowedTo(page, "Focus");
  await expect(page.getByText("productive category", { exact: true })).toBeVisible();
  // One category is one productivity state, so its bars split by member instead.
  await expect(page.getByText("By app and website", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Stack bars by" })).toHaveCount(0);

  await page.getByRole("button", { name: "Chrome", exact: true }).click();
  await narrowedTo(page, "Chrome");
  // The category it is held in leads the subject, and is the way back to it.
  const backToFocus = page.getByRole("button", { name: "Focus", exact: true });
  await expect(backToFocus).toHaveAttribute("title", "Back to Focus");
  // Chrome's Focus sites, and not metrics.corp.example, which no rule classifies.
  await expect(tile(page, "Time in range")).toContainText("7h 14m");
  await expect(page.getByRole("button", { name: /docs\.example\.com/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /mail\.corp\.example/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /metrics\.corp\.example/ })).toHaveCount(0);

  // Back goes one level, to the category the app was opened from.
  await backToFocus.click();
  await narrowedTo(page, "Focus");

  // The whole app, from anywhere else, is all of it.
  await showAll(page);
  await page.getByRole("button", { name: "Chrome", exact: true }).click();
  await narrowedTo(page, "Chrome");
  await expect(tile(page, "Time in range")).toContainText("7h 49m");
});

test("@workflow a top window opens in Activity, and the panels count runs as Insights does", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Slack", exact: true }).click();
  await page.getByRole("button", { name: "Product Design — Time", exact: true }).click();

  const window = page.getByRole("complementary", { name: "Window details: Product Design — Time — Slack" });
  await expect(window).toBeVisible();
  await expect(tile(window, "Typical run")).toHaveText("54m");

  // Opened inside its app, so Back reaches the app rather than closing.
  await window.getByRole("button", { name: "Back to Slack details" }).click();
  const entity = page.getByRole("complementary", { name: "Activity details: Slack" });
  await expect(entity).toBeVisible();
  // The app's panel leaves run length to Insights, one link away.
  await expect(entity.getByLabel(/^Typical run\./)).toHaveCount(0);
  await expect(entity.getByText("Average visit")).toHaveCount(0);

  await entity.getByRole("button", { name: "View insights" }).click();
  await narrowedTo(page, "Slack");
  await expect(tile(page, "Typical run")).toHaveText("54m");
});

test("@workflow the scope picker is driven from the keyboard", async ({ page }) => {
  await page.goto("/");
  const trigger = subject(page);
  await expect(trigger).toHaveAccessibleName("Narrow Insights: All activity");

  await trigger.click();
  const search = page.getByRole("combobox", { name: "Find an app, website, or category" });
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.press("ArrowDown");
  await search.fill("sla");
  await search.press("Enter");
  await expect(trigger).toHaveAccessibleName("Narrow Insights: Slack");

  // Opening again starts on the current subject. The list has no way back
  // out of its own; the clear button beside the subject is that.
  await trigger.click();
  await expect(page.getByRole("option", { name: /^Slack/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option", { name: /^All activity/ })).toHaveCount(0);
  await search.press("Escape");
  await showAll(page);
  await expect(trigger).toHaveAccessibleName("Narrow Insights: All activity");
});
