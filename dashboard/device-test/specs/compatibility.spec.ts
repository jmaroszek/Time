import { expect, test, type Page } from "@playwright/test";

const FIXED_NOW = new Date("2026-07-30T17:00:00.000Z");

test.beforeEach(async ({ page }) => {
  // Apply before the first navigation: the fixture captures Date.now() while
  // its module loads. Fixed Date keeps real timers alive for chart settling.
  await page.clock.setFixedTime(FIXED_NOW);
});

async function waitForDashboard(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Insights", exact: true })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
}

async function assertNoHorizontalOverflow(page: Page) {
  const report = await page.evaluate(() => {
    const scopes = [
      document.documentElement,
      document.body,
      document.querySelector<HTMLElement>(".app-viewport"),
    ].filter((value): value is HTMLElement => value !== null);
    const overflowingScopes = scopes
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({
        node: node === document.documentElement
          ? "html"
          : node === document.body
            ? "body"
            : node.className,
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }));
    const viewportOffenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((node) => {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 1 && (rect.left < -1 || rect.right > window.innerWidth + 1);
      })
      .slice(0, 10)
      .map((node) => ({
        tag: node.tagName,
        className: node.className,
        rect: node.getBoundingClientRect().toJSON(),
      }));
    return { overflowingScopes, viewportOffenders };
  });
  expect(report).toEqual({ overflowingScopes: [], viewportOffenders: [] });
}

async function assertChartsHaveGeometry(page: Page) {
  const charts = await page.locator("canvas").evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      const parent = item.parentElement?.getBoundingClientRect();
      const card = item.closest<HTMLElement>('div[class*="rounded-[14px]"]')
        ?.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        parentWidth: parent?.width ?? 0,
        left: rect.left,
        right: rect.right,
        cardLeft: card?.left ?? 0,
        cardRight: card?.right ?? window.innerWidth,
      };
    })
  );
  expect(charts.length).toBeGreaterThan(0);
  for (const chart of charts) {
    expect(chart.width).toBeGreaterThan(0);
    expect(chart.height).toBeGreaterThan(0);
    expect(chart.width).toBeLessThanOrEqual(chart.parentWidth + 1);
    expect(chart.left).toBeGreaterThanOrEqual(chart.cardLeft - 1);
    expect(chart.right).toBeLessThanOrEqual(chart.cardRight + 1);
  }
}

async function assertOpenMenuFitsViewport(page: Page) {
  const menu = page.locator(".menu-pop:visible");
  await expect(menu).toBeVisible();
  await menu.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished))
  );
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(7);
  expect(box!.y).toBeGreaterThanOrEqual(7);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width - 7);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height - 7);
}

test("@matrix primary screens remain usable at the effective viewport contract", async ({
  page,
}, testInfo) => {
  await waitForDashboard(page);
  const width = testInfo.project.use.viewport?.width ?? 0;
  await assertNoHorizontalOverflow(page);
  await assertChartsHaveGeometry(page);
  if (width < 640) {
    const topAppRow = page.locator(".top-app-row").first();
    const [rowBox, durationBox, changeBox] = await Promise.all([
      topAppRow.boundingBox(),
      topAppRow.locator(".top-app-duration").boundingBox(),
      topAppRow.locator(".top-app-change").boundingBox(),
    ]);
    expect(rowBox).not.toBeNull();
    expect(durationBox).not.toBeNull();
    expect(changeBox).not.toBeNull();
    const rowRight = rowBox!.x + rowBox!.width;
    expect(durationBox!.x + durationBox!.width).toBeLessThanOrEqual(rowRight + 1);
    expect(changeBox!.x + changeBox!.width).toBeLessThanOrEqual(rowRight + 1);
  }

  const datePreset = page.getByRole("combobox", { name: "Date range preset" });
  const dateRangeRow = datePreset.locator("..");
  const [dateRangeBox, headerBox] = await Promise.all([
    dateRangeRow.boundingBox(),
    page.locator(".time-shell > header").boundingBox(),
  ]);
  expect(dateRangeBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(
    Math.abs(
      dateRangeBox!.x + dateRangeBox!.width -
        (headerBox!.x + headerBox!.width)
    )
  ).toBeLessThanOrEqual(1);
  if (width < 640) {
    const rolling = page.getByRole("checkbox", { name: "Rolling" }).locator("..");
    const dates = page.locator('input[type="date"]');
    const controls = [rolling, datePreset, dates.nth(0), dates.nth(1)];
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    const centerLines = boxes.map((box) => box!.y + box!.height / 2);
    expect(Math.max(...centerLines) - Math.min(...centerLines)).toBeLessThanOrEqual(1);
    expect(boxes[2]!.width).toBeLessThanOrEqual(129);
    expect(boxes[3]!.width).toBeLessThanOrEqual(129);
    expect(boxes[3]!.x + boxes[3]!.width).toBeLessThanOrEqual(width);
  }
  await datePreset.press("Enter");
  await assertOpenMenuFitsViewport(page);
  await datePreset.press("m");
  await datePreset.press("Enter");
  await expect(page.getByText("Activity Calendar", { exact: true })).toBeVisible();
  await assertChartsHaveGeometry(page);
  await assertNoHorizontalOverflow(page);

  const aggregateView = page.getByRole("combobox", { name: "Aggregate view" });
  await aggregateView.click();
  await page.getByRole("option", { name: "Rhythm", exact: true }).click();
  await expect(page.getByText("Activity Rhythm", { exact: true })).toBeVisible();
  await assertChartsHaveGeometry(page);
  await assertNoHorizontalOverflow(page);

  await datePreset.click();
  await page.getByRole("option", { name: "Year", exact: true }).click();
  await aggregateView.click();
  await page.getByRole("option", { name: "Calendar", exact: true }).click();
  await expect(page.getByText(/time by day$/i)).toBeVisible();
  await assertChartsHaveGeometry(page);
  await assertNoHorizontalOverflow(page);

  await datePreset.click();
  await page.getByRole("option", { name: "All time", exact: true }).click();
  await expect(page.getByText(/time by month$/i)).toBeVisible();
  await assertChartsHaveGeometry(page);
  await assertNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("button", { name: "Activity Library", exact: true })).toBeVisible();
  if (width < 768) {
    await expect(page.getByRole("columnheader", { name: "Days seen" })).toHaveCount(0);
  } else {
    await expect(page.getByRole("columnheader", { name: "Days seen" })).toBeVisible();
  }
  await expect(page.locator("tbody button").first()).toHaveAccessibleName(
    /% of recorded time in range.*days seen.*last seen/i,
  );

  const activityType = page.getByRole("combobox", { name: "Activity type" });
  await activityType.click();
  await assertOpenMenuFitsViewport(page);
  await page.getByRole("option", { name: "Apps", exact: true }).click();
  await assertNoHorizontalOverflow(page);

  const classificationFilter = page.getByRole("combobox", { name: "Classification filter" });
  await classificationFilter.click();
  await assertOpenMenuFitsViewport(page);
  await page.keyboard.press("Escape");
  await expect(classificationFilter).toBeFocused();

  const rowTrigger = page.locator("tbody button").first();
  await expect(rowTrigger).toBeVisible();
  await rowTrigger.click();
  await expect(page.getByRole("complementary")).toBeVisible();

  if (width < 1832) {
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Close activity details" }),
    ).toBeVisible();
  } else {
    await expect(page.getByRole("table")).toBeVisible();
  }
  await assertNoHorizontalOverflow(page);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(rowTrigger).toBeFocused();

  if (width < 1832) {
    await rowTrigger.click();
    await page.getByRole("button", { name: "Close activity details" }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await expect(rowTrigger).toBeFocused();
  }

  await rowTrigger.click();
  await page.getByRole("button", { name: "Close activity details" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(rowTrigger).toBeFocused();

  await page.getByRole("button", { name: "Categories & Rules", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ Add category", exact: true })).toBeVisible();
  if (width < 640) {
    const categoryOrder = page.getByRole("combobox", { name: "Category order" });
    const ruleOrder = page.getByRole("combobox", { name: "Rule order" });
    const [categoryBox, ruleBox] = await Promise.all([
      categoryOrder.boundingBox(),
      ruleOrder.boundingBox(),
    ]);
    expect(categoryBox).not.toBeNull();
    expect(ruleBox).not.toBeNull();
    expect(Math.abs(categoryBox!.y - ruleBox!.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(categoryBox!.width - ruleBox!.width)).toBeLessThanOrEqual(2);

  }
  const newCategory = page.getByPlaceholder("New category name");
  const addCategory = page.getByRole("button", { name: "+ Add category", exact: true });
  await newCategory.scrollIntoViewIfNeeded();
  const [newCategoryBox, addCategoryBox] = await Promise.all([
    newCategory.boundingBox(),
    addCategory.boundingBox(),
  ]);
  expect(newCategoryBox).not.toBeNull();
  expect(addCategoryBox).not.toBeNull();
  expect(newCategoryBox!.width).toBeLessThanOrEqual(225);
  expect(Math.abs(newCategoryBox!.y - addCategoryBox!.y)).toBeLessThanOrEqual(3);
  expect(addCategoryBox!.x).toBeGreaterThan(newCategoryBox!.x + newCategoryBox!.width);
  await page.getByRole("button", { name: "Expand Focus rules" }).click();
  await expect(page.getByText("code.exe", { exact: true })).toBeVisible();
  if (width < 640) {
    const ruleType = page.getByRole("group", { name: "Rule type" }).first();
    await ruleType.getByRole("button", { name: "Window", exact: true }).click();
    const appliesTo = page.getByText("Applies to", { exact: true }).last();
    const appliesRow = appliesTo.locator("..");
    const websiteScope = appliesRow.getByRole("button", {
      name: "Website",
      exact: true,
    });
    await websiteScope.click();
    const scopeInput = page.getByPlaceholder("example.com");
    const [websiteBox, scopeBox] = await Promise.all([
      websiteScope.boundingBox(),
      scopeInput.boundingBox(),
    ]);
    expect(websiteBox).not.toBeNull();
    expect(scopeBox).not.toBeNull();
    expect(scopeBox!.y).toBeGreaterThan(websiteBox!.y + websiteBox!.height - 1);
    expect(scopeBox!.width).toBeGreaterThan(200);
  }
  await page.getByRole("button", { name: "Change color of Focus" }).click();
  await expect(page.getByRole("button", { name: /Use color/i }).first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Close menu" }).click();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // Scoped to the section itself: Settings' section rail lists the same labels
  // as anchor links, so an unscoped text match is ambiguous at the widths where
  // the rail is shown. The assertion is unchanged — the section has rendered.
  await expect(
    page.locator("#settings-tracker-status").getByText("Tracker status", { exact: true }),
  ).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

test("@minimum onboarding and restore dialog fit the minimum viewport", async ({
  page,
}) => {
  await page.goto("/?fixture=onboarding");
  await expect(page.getByRole("heading", { name: "Choose what Time may record" })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await expect(page.getByRole("button", { name: "Start tracking" })).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const switchBoxes = await Promise.all(
    ["Record activity", "Store window titles", "Start at Windows sign-in", "Show tray icon"].map(
      (name) => page.getByRole("switch", { name }).boundingBox(),
    ),
  );
  expect(switchBoxes.every((box) => box !== null)).toBe(true);
  const switchXs = switchBoxes.map((box) => box!.x);
  expect(Math.max(...switchXs) - Math.min(...switchXs)).toBeLessThanOrEqual(1);

  const dayStartControlWidth = await page
    .getByRole("textbox", { name: "Day starts at", exact: true })
    .evaluate((input) => input.parentElement?.parentElement?.getBoundingClientRect().width ?? 0);
  const weekStartWidth = await page
    .getByRole("radiogroup", { name: "Week starts on" })
    .evaluate((group) => group.getBoundingClientRect().width);
  expect(dayStartControlWidth).toBeLessThan(140);
  expect(weekStartWidth).toBeLessThan(180);

  await page.getByRole("button", { name: "Restore backup…" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore backup" });
  await expect(dialog).toBeVisible();
  await assertNoHorizontalOverflow(page);
  const box = await dialog.boundingBox();
  expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(480 - 8);
});

// The native WebView2 suite covered this walk before; the project matrix
// already spans the snap-equivalent sizes, so the tab cycle belongs here and
// the native suite keeps only what a browser cannot reach.
test("@minimum every primary tab stays reachable at the minimum viewport", async ({
  page,
}) => {
  await waitForDashboard(page);

  for (const tab of ["Activity", "Settings", "Insights"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await assertNoHorizontalOverflow(page);
  }
  await expect(page.locator("canvas").first()).toBeVisible();
  await assertChartsHaveGeometry(page);

  // Activity keeps its last sub-view, so return to the library explicitly
  // before reaching for a row.
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Activity Library", exact: true }).click();
  const rowTrigger = page.locator("tbody button").first();
  await expect(rowTrigger).toBeVisible();
  await rowTrigger.click();
  await expect(page.getByRole("complementary")).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Close activity details" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(rowTrigger).toBeFocused();
});

test("@dpr charts render at high device pixel ratio", async ({ page }) => {
  await waitForDashboard(page);
  await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(2);
  const ratio = await page.locator("canvas").first().evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return canvas.width / rect.width;
  });
  expect(ratio).toBeGreaterThanOrEqual(1.9);
  await assertNoHorizontalOverflow(page);
});

test("@settle charts settle after repeated responsive transitions", async ({
  page,
}) => {
  await waitForDashboard(page);

  for (const viewport of [
    { width: 500, height: 480 },
    { width: 960, height: 540 },
    { width: 640, height: 480 },
    { width: 500, height: 480 },
    { width: 1008, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const charts = await page.locator("canvas").evaluateAll((items) =>
        items.map((item) => {
          const rect = item.getBoundingClientRect();
          const card = item.closest<HTMLElement>('div[class*="rounded-[14px]"]')
            ?.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            cardLeft: card?.left ?? 0,
            cardRight: card?.right ?? window.innerWidth,
          };
        })
      );
      return charts.length > 0 && charts.every((chart) =>
        chart.width > 0
        && chart.height > 0
        && chart.left >= chart.cardLeft - 1
        && chart.right <= chart.cardRight + 1
      );
    }).toBe(true);
    await assertNoHorizontalOverflow(page);
  }
});
