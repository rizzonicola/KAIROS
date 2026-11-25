/** UCI clock handling for the headless engine. */

/** Convert UCI clock parameters into a bounded `go movetime` the controller understands. */
export function convertGo(goLine: string, sideToMove: "w" | "b", overheadMs: number, standalone: boolean): string {
  const tokens = goLine.trim().split(/\s+/);
  const num = (name: string): number | null => {
    const index = tokens.indexOf(name);
    const value = index >= 0 ? Number.parseInt(tokens[index + 1] ?? "", 10) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  if (tokens.includes("infinite")) {
    return standalone ? "go movetime 3600000" : goLine;
  }
  if (tokens.includes("movetime") || tokens.includes("depth")) {
    return goLine;
  }
  const time = num(sideToMove === "w" ? "wtime" : "btime");
  if (time === null) {
    return goLine;
  }
  const increment = num(sideToMove === "w" ? "winc" : "binc") ?? 0;
  const movesToGo = Math.max(1, Math.min(num("movestogo") ?? 30, 60));
  const wanted = time / movesToGo + increment * 0.75;
  const ceiling = Math.max(20, time * 0.5 - overheadMs);
  const movetime = Math.max(20, Math.min(Math.trunc(wanted), Math.trunc(ceiling), time - overheadMs - 20));
  return `go movetime ${movetime}`;
}
