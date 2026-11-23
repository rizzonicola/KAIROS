import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("index.html exposes the app root and module entry", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('id="app"');
    expect(html).toContain('type="module"');
  });
});
