import { expect, test } from "@playwright/test";

test("plays a move and the engine replies with a rationale", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready", {
    timeout: 30_000,
  });

  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(page.locator("#rationale")).toBeVisible();
  await expect(page.locator("#rationale")).not.toBeEmpty();

  const thinkMs = await page.evaluate(
    () =>
      (window as unknown as { __kairos?: { lastThinkMs: number } }).__kairos
        ?.lastThinkMs ?? 0,
  );
  const readyMs = await page.evaluate(
    () =>
      (window as unknown as { __kairos?: { readyMs: number } }).__kairos
        ?.readyMs ?? 0,
  );
  console.log(`browser ready ${readyMs} ms, think ${thinkMs} ms`);
  expect(thinkMs).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("shows a blocking error when the engine cannot load", async ({ page }) => {
  await page.route("**/stockfish-19-lite-single.wasm", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#error-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#retry")).toBeVisible();
});

test("drops a stale reply after starting a new game", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready", {
    timeout: 30_000,
  });

  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await page.locator("#new-game").click();

  await page.waitForTimeout(2_500);
  await expect(page.locator("#move-list li")).toHaveCount(0);
  await expect(page.locator("#status")).toContainText("Ready");
  await expect(page.locator('[data-square="e2"]')).toContainText("♙");

  await page.selectOption("#side", "b");
  await expect(page.locator("#move-list li")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator("#move-list li")).toHaveCount(1);
});
