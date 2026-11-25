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

  const wasmResponses = new Map<string, number>();
  page.on("response", (response) => {
    const url = response.url();
    if (url.endsWith(".wasm")) {
      wasmResponses.set(url.split("/").pop() ?? url, response.status());
    }
  });

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready", {
    timeout: 30_000,
  });
  await expect(page.locator("#engine-badge")).toHaveAttribute("data-mode", "stockfish");

  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(page.locator("#rationale")).toBeVisible();
  await expect(page.locator("#rationale")).not.toBeEmpty();
  await expect(page.locator("#rationale")).toHaveAttribute(
    "data-kind",
    /^(rerank|fallback|stockfish)$/,
  );
  await expect(page.locator("#rationale .rationale-summary")).toContainText(
    "Stockfish",
  );
  await expect(
    page
      .locator("#rationale .rationale-block", { hasText: "Posture mix" })
      .locator("li"),
  ).toHaveCount(6);
  // both WebAssembly modules were served over plain HTTP
  expect(wasmResponses.get("stockfish-19-lite-single.wasm")).toBe(200);
  expect(wasmResponses.get("kairos_core_bg.wasm")).toBe(200);

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

test("falls back to KAIROS standalone when Stockfish cannot load", async ({ page }) => {
  await page.route("**/stockfish-19-lite-single.wasm", (route) => route.abort());
  await page.route("**/stockfish-19-lite-single.js", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#engine-badge")).toHaveAttribute("data-mode", "standalone", {
    timeout: 45_000,
  });
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator("#rationale")).toHaveAttribute("data-kind", "standalone");
});

test("Style 0 is an exact Stockfish passthrough", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
  await page.locator("#style").fill("0");
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator("#rationale")).toHaveAttribute("data-kind", "stockfish");
});

test("undo takes back the last move pair", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 30_000 });
  await page.locator("#undo").click();
  await expect(page.locator("#move-list li")).toHaveCount(0);
  await expect(page.locator('[data-square="e2"]')).toContainText("♙");
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
