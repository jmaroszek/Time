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

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

// Every fixture day has the same shape: Explorer from 12:00 to 13:01, Slack
// from 13:00 for 54 minutes, then nothing until Chrome at 14:00. The default
// range is the last seven days, so Slack is one 54-minute run on each of them.

test("@workflow a Top Apps row narrows Insights to that app, and back out", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Slack", exact: true }).click();

  await expect(heading(page)).toHaveText("Slack");
  await expect(tile(page, "Time in range")).toContainText("6h 18m");
  await expect(tile(page, "Days used")).toHaveText(/^7\s*of 7$/);
  await expect(tile(page, "Runs per day")).toHaveText("1");
  await expect(tile(page, "Typical run")).toHaveText("54m");
  await expect(page.getByRole("button", { name: "Product Design — Time — Slack" })).toBeVisible();

  // Explorer overlaps the start of every run; six quiet minutes follow each one.
  const before = page.getByRole("region", { name: "Before" });
  const after = page.getByRole("region", { name: "After" });
  await expect(before).toContainText("Explorer");
  await expect(before.getByLabel("100%, 7 of 7 runs")).toBeVisible();
  await expect(after).toContainText("Idle or away");
  await expect(after.getByLabel("100%, 7 of 7 runs")).toBeVisible();

  await page.getByRole("button", { name: "All activity", exact: true }).click();
  await expect(heading(page)).toHaveCount(0);
  await expect(page.getByText("Top Apps", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Daily productive time\./)).toBeVisible();
});

test("@workflow an app opened from a category stays inside that category", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Narrow Insights/ }).click();
  await page.getByRole("combobox", { name: "Find an app, website, or category" }).fill("focus");
  await page.getByRole("option", { name: /^Focus/ }).click();

  await expect(heading(page)).toHaveText("Focus");
  await expect(page.getByText("Category · Productive")).toBeVisible();
  // One category is one productivity state, so its bars split by member instead.
  await expect(page.getByText("By app and website", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Stack bars by" })).toHaveCount(0);

  await page.getByRole("button", { name: "Chrome", exact: true }).click();
  await expect(heading(page)).toHaveText("Chrome");
  await expect(page.getByText("App · Focus only")).toBeVisible();
  // Chrome's Focus sites, and not metrics.corp.example, which no rule classifies.
  await expect(tile(page, "Time in range")).toContainText("7h 14m");
  await expect(page.getByRole("button", { name: /docs\.example\.com/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /mail\.corp\.example/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /metrics\.corp\.example/ })).toHaveCount(0);

  // Back goes one level, to the category the app was opened from.
  await page.getByRole("button", { name: "Focus", exact: true }).click();
  await expect(heading(page)).toHaveText("Focus");

  // The whole app, from anywhere else, is all of it.
  await page.getByRole("button", { name: "All activity", exact: true }).click();
  await page.getByRole("button", { name: "Chrome", exact: true }).click();
  await expect(heading(page)).toHaveText("Chrome");
  await expect(tile(page, "Time in range")).toContainText("7h 49m");
});

test("@workflow a top window opens in Activity, and the panels count runs as Insights does", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Slack", exact: true }).click();
  await page.getByRole("button", { name: "Product Design — Time — Slack" }).click();

  const window = page.getByRole("complementary", { name: "Window details: Product Design — Time — Slack" });
  await expect(window).toBeVisible();
  await expect(tile(window, "Typical run")).toHaveText("54m");

  // Opened inside its app, so Back reaches the app rather than closing.
  await window.getByRole("button", { name: "Back to Slack details" }).click();
  const entity = page.getByRole("complementary", { name: "Activity details: Slack" });
  await expect(entity).toBeVisible();
  await expect(tile(entity, "Typical run")).toHaveText("54m");
  await expect(entity.getByText("Average visit")).toHaveCount(0);

  await entity.getByRole("button", { name: "View in Insights" }).click();
  await expect(heading(page)).toHaveText("Slack");
  await expect(tile(page, "Typical run")).toHaveText("54m");
});

test("@workflow the scope picker is driven from the keyboard", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /^Narrow Insights/ });
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
  await expect(heading(page)).toHaveText("Slack");
  await expect(trigger).toHaveAccessibleName("Narrow Insights: Slack");

  // Opening again starts on the current subject, and the list leads with the
  // way back out.
  await trigger.click();
  await expect(page.getByRole("option", { name: /^Slack/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("option", { name: /^All activity/ }).click();
  await expect(heading(page)).toHaveCount(0);
});
