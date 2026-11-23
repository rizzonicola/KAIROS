import { expect, test } from "@playwright/test";

// Answers the handshake but never a search, so the watchdog can be driven
// deterministically with Playwright's fake clock.
const STUB_ENGINE = `
self.onmessage = (event) => {
  const line = event.data;
  if (line === "uci") {
    self.postMessage("id name Stockfish 19 Lite stub");
    self.postMessage("uciok");
  } else if (line === "isready") {
    self.postMessage("readyok");
  }
};
`;

test("watchdog restarts the stack once, then blocks until Retry", async ({
  page,
}) => {
  await page.clock.install();
  await page.route("**/engine/stockfish-19-lite-single.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: STUB_ENGINE }),
  );
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready", {
    timeout: 30_000,
  });

  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator("#status")).toContainText("thinking", {
    timeout: 10_000,
  });

  // First timeout: send stop, wait the grace period, recreate the whole stack.
  await page.clock.fastForward(12_001);
  await page.clock.fastForward(2_001);
  await expect(page.locator("#status")).toContainText("thinking", {
    timeout: 10_000,
  });

  // Second timeout: no automatic restart left, so the engine is blocked.
  await page.clock.fastForward(12_001);
  await page.clock.fastForward(2_001);
  await expect(page.locator("#error-banner")).toBeVisible();
  await expect(page.locator("#new-game")).toBeDisabled();
  await expect(page.locator("#status")).toContainText("disabled");

  await page.locator("#retry").click();
  await expect(page.locator("#error-banner")).toBeHidden();
  await expect(page.locator("#new-game")).toBeEnabled({ timeout: 10_000 });
});
