import { describe, expect, it } from "vitest";
import { convertGo } from "../tools/uci-time";

describe("UCI clock conversion", () => {
  it("keeps explicit limits", () => {
    expect(convertGo("go movetime 2000", "w", 100, false)).toBe("go movetime 2000");
    expect(convertGo("go depth 12", "b", 100, false)).toBe("go depth 12");
  });

  it("passes infinite searches to Stockfish and bounds them in standalone mode", () => {
    expect(convertGo("go infinite", "w", 100, false)).toBe("go infinite");
    expect(convertGo("go infinite", "w", 100, true)).toBe("go movetime 3600000");
  });

  it("turns clocks into a bounded movetime for the side to move", () => {
    // 60 s, 1 s increment, 30 moves assumed: 60000/30 + 750 = 2750 ms
    expect(convertGo("go wtime 60000 btime 1000 winc 1000 binc 0", "w", 100, false)).toBe("go movetime 2750");
    // black has 1 s left: never more than half the clock minus overhead
    const black = convertGo("go wtime 60000 btime 1000 winc 0 binc 0", "b", 100, false);
    const ms = Number(black.split(" ")[2]);
    expect(ms).toBeLessThanOrEqual(400);
    expect(ms).toBeGreaterThanOrEqual(20);
  });

  it("respects movestogo and never exceeds the remaining time", () => {
    const line = convertGo("go wtime 5000 btime 5000 movestogo 1", "w", 100, false);
    const ms = Number(line.split(" ")[2]);
    expect(ms).toBeLessThan(5000);
    expect(ms).toBeLessThanOrEqual(2400);
  });

  it("leaves searches without any limit untouched", () => {
    expect(convertGo("go", "w", 100, false)).toBe("go");
    expect(convertGo("go nodes 1000", "w", 100, false)).toBe("go nodes 1000");
  });
});
