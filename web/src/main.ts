import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import type { KairosOptions, Rationale } from "./controller";
import { EngineHost } from "./engine-host";
import { applyEngineMove, positionCommand } from "./game";
import type { Posture } from "./postures";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import "./style.css";

declare global {
  interface Window {
    __kairos?: { lastThinkMs: number; readyMs: number };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("missing #app root");
}

const POSTURES = [
  "Auto",
  "Coil",
  "Strike",
  "Absorb",
  "Reverse",
  "Distill",
  "Fog",
] as const;

app.innerHTML = `
  <main class="shell">
    <header class="masthead">
      <h1>KAIROS <span>Web Lite</span></h1>
      <p class="tagline">A personality around Stockfish 19 Lite, running entirely in your browser.</p>
    </header>
    <div class="layout">
      <section class="board-column">
        <div id="board" class="board" role="grid" aria-label="Chess board"></div>
        <p id="status" class="status" aria-live="polite">Loading the engine…</p>
        <p id="engine-line" class="engine-line"></p>
        <div id="alert" class="alert" role="alert" hidden>
          <p id="alert-text"></p>
          <button id="alert-action" type="button">Retry</button>
        </div>
      </section>
      <aside class="panel">
        <div class="controls">
          <label>Play as
            <select id="side">
              <option value="w">White</option>
              <option value="b">Black</option>
            </select>
          </label>
          <label>Think time
            <select id="think">
              <option value="1500">1.5 s</option>
              <option value="2000" selected>2 s</option>
              <option value="3000">3 s</option>
              <option value="5000">5 s</option>
              <option value="10000">10 s</option>
            </select>
          </label>
          <label>Style <output id="style-value">50</output>
            <input id="style" type="range" min="0" max="100" step="1" value="50" />
          </label>
          <label>Posture
            <select id="posture">
              ${POSTURES.map((name) => `<option value="${name}">${name}</option>`).join("")}
            </select>
          </label>
          <label>Variety <output id="variety-value">0</output>
            <input id="variety" type="range" min="0" max="100" step="1" value="0" />
          </label>
          <div class="row">
            <button id="new-game" type="button">New game</button>
            <button id="flip" type="button">Flip</button>
          </div>
        </div>
        <ol id="moves" class="moves" aria-label="Move list"></ol>
        <p id="rationale" class="rationale" aria-live="polite"></p>
      </aside>
    </div>
  </main>
  <dialog id="promotion" class="promotion">
    <p>Promote to</p>
    <div class="promotion-pieces">
      <button type="button" data-piece="q" aria-label="Queen">♕</button>
      <button type="button" data-piece="r" aria-label="Rook">♖</button>
      <button type="button" data-piece="b" aria-label="Bishop">♗</button>
      <button type="button" data-piece="n" aria-label="Knight">♘</button>
    </div>
  </dialog>
`;

function element<T extends Element>(selector: string): T {
  const found = app!.querySelector<T>(selector);
  if (!found) {
    throw new Error(`missing ${selector}`);
  }
  return found;
}

const boardEl = element<HTMLDivElement>("#board");
const statusEl = element<HTMLParagraphElement>("#status");
const engineLineEl = element<HTMLParagraphElement>("#engine-line");
const alertEl = element<HTMLDivElement>("#alert");
const alertTextEl = element<HTMLParagraphElement>("#alert-text");
const alertActionEl = element<HTMLButtonElement>("#alert-action");
const movesEl = element<HTMLOListElement>("#moves");
const rationaleEl = element<HTMLParagraphElement>("#rationale");
const sideEl = element<HTMLSelectElement>("#side");
const thinkEl = element<HTMLSelectElement>("#think");
const styleEl = element<HTMLInputElement>("#style");
const styleValueEl = element<HTMLOutputElement>("#style-value");
const postureEl = element<HTMLSelectElement>("#posture");
const varietyEl = element<HTMLInputElement>("#variety");
const varietyValueEl = element<HTMLOutputElement>("#variety-value");
const newGameEl = element<HTMLButtonElement>("#new-game");
const flipEl = element<HTMLButtonElement>("#flip");
const promotionEl = element<HTMLDialogElement>("#promotion");

const GLYPHS: Record<string, string> = {
  wp: "♙",
  wn: "♘",
  wb: "♗",
  wr: "♖",
  wq: "♕",
  wk: "♔",
  bp: "♟",
  bn: "♞",
  bb: "♝",
  br: "♜",
  bq: "♛",
  bk: "♚",
};

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const allowUnverifiedEngine =
  new URLSearchParams(window.location.search).get("dev") === "1";

let game = new Chess();
let playerColor: "w" | "b" = "w";
let flipped = false;
let style = 50;
let posture: Posture | "Auto" = "Auto";
let variety = 0;
let thinkTime = 2000;
let selected: Square | null = null;
let lastMove: { from: string; to: string } | null = null;
let pendingPromotion: { from: Square; to: Square } | null = null;

let controller: Worker;
let host: EngineHost;
let ready = false;
let engineDisabled = false;
let thinking = false;
let requestCounter = 0;
let activeRequest = 0;
let initStartedAt = 0;
let thinkStartedAt = 0;
let readyMs = 0;
let lastThinkMs = 0;
let initTimer: number | null = null;
let watchdog: number | null = null;

window.__kairos = { lastThinkMs, readyMs };

function post(message: WorkerRequest): void {
  controller.postMessage(message);
}

function sendInit(): void {
  const options: Partial<KairosOptions> = {
    style,
    posture,
    variety,
    allowUnverifiedEngine,
  };
  post({ type: "init", options, seed: Date.now() });
}

function connect(): void {
  controller = new Worker(new URL("./kairos-worker.ts", import.meta.url), {
    type: "module",
  });
  controller.onmessage = (event: MessageEvent<WorkerResponse>) => {
    handleControllerMessage(event.data);
  };

  host = new EngineHost(
    () =>
      new Worker(
        new URL("engine/stockfish-19-lite-single.js", document.baseURI),
      ),
    (line) => post({ type: "engine-line", line }),
    () => handleEngineFailure("The engine stopped unexpectedly."),
  );

  ready = false;
  initStartedAt = performance.now();
  readyMs = 0;
  window.__kairos!.readyMs = 0;
  sendInit();
  armInitTimer();
}

function handleControllerMessage(message: WorkerResponse): void {
  switch (message.type) {
    case "ready":
      ready = true;
      clearInitTimer();
      readyMs = Math.round(performance.now() - initStartedAt);
      window.__kairos!.readyMs = readyMs;
      setStatus(statusText());
      if (engineToMove()) {
        askEngine();
      }
      return;
    case "engine-send":
      host.send(message.line);
      return;
    case "bestmove":
      handleBestmove(message.move, message.rationale, message.requestId);
      return;
    case "engine-info":
      if (thinking) {
        engineLineEl.textContent = `depth ${message.depth} · score ${message.score}`;
      }
      return;
    case "error":
      if (!message.recoverable) {
        blockEngine(message.message, "retry");
      } else {
        setStatus(message.message);
      }
      return;
    case "log":
    case "quit":
      return;
  }
}

function armInitTimer(): void {
  clearInitTimer();
  initTimer = window.setTimeout(() => {
    handleEngineFailure("The engine did not start in time.");
  }, 10_000);
}

function clearInitTimer(): void {
  if (initTimer !== null) {
    window.clearTimeout(initTimer);
    initTimer = null;
  }
}

function armWatchdog(milliseconds: number): void {
  clearWatchdog();
  watchdog = window.setTimeout(() => {
    handleEngineFailure("The engine did not answer in time.");
  }, milliseconds);
}

function clearWatchdog(): void {
  if (watchdog !== null) {
    window.clearTimeout(watchdog);
    watchdog = null;
  }
}

function handleEngineFailure(message: string): void {
  if (engineDisabled) {
    return;
  }
  clearWatchdog();
  clearInitTimer();
  thinking = false;
  if (host.restart()) {
    initStartedAt = performance.now();
    sendInit();
    armInitTimer();
    render();
    setStatus(`${message} Restarting the engine…`);
    return;
  }
  blockEngine(message, "retry");
}

function blockEngine(message: string, action: "retry" | "newgame"): void {
  clearWatchdog();
  clearInitTimer();
  engineDisabled = true;
  thinking = false;
  alertTextEl.textContent = message;
  alertActionEl.textContent = action === "retry" ? "Retry" : "New game";
  alertActionEl.dataset.action = action;
  alertEl.hidden = false;
  render();
}

function hideAlert(): void {
  alertEl.hidden = true;
}

function engineToMove(): boolean {
  return !game.isGameOver() && game.turn() !== playerColor;
}

function askEngine(): void {
  if (!ready || engineDisabled || thinking || !engineToMove()) {
    return;
  }
  thinking = true;
  thinkStartedAt = performance.now();
  activeRequest = ++requestCounter;
  engineLineEl.textContent = "";
  post({ type: "position", command: positionCommand(game) });
  post({
    type: "go",
    command: `go movetime ${thinkTime}`,
    requestId: activeRequest,
  });
  armWatchdog(thinkTime + 10_000);
  render();
}

function handleBestmove(
  move: string,
  rationale: Rationale,
  requestId?: number,
): void {
  if (!thinking || requestId !== activeRequest) {
    return;
  }
  thinking = false;
  clearWatchdog();
  lastThinkMs = Math.round(performance.now() - thinkStartedAt);
  window.__kairos!.lastThinkMs = lastThinkMs;

  const applied = applyEngineMove(game, move);
  if (!applied) {
    blockEngine(
      `The engine returned an illegal move (${move || "none"}).`,
      "newgame",
    );
    return;
  }
  lastMove = { from: applied.from, to: applied.to };
  selected = null;
  showRationale(rationale);
  render();
}

function showRationale(rationale: Rationale): void {
  if (rationale.kind === "rerank") {
    rationaleEl.textContent =
      `${rationale.posture} · plan ${rationale.plan} · ` +
      `loss ${rationale.lossPct.toFixed(2)}% · pick ${rationale.pick} ` +
      `(Stockfish ${rationale.sfBest})`;
    return;
  }
  if (rationale.kind === "fallback") {
    rationaleEl.textContent = `Stockfish best · ${rationale.reason}`;
    return;
  }
  rationaleEl.textContent = `Stockfish · ${rationale.reason}`;
}

function statusText(): string {
  if (engineDisabled) {
    return "The engine is disabled for this game.";
  }
  if (thinking) {
    return "KAIROS is thinking…";
  }
  if (!ready) {
    return "Loading the engine…";
  }
  if (game.isCheckmate()) {
    return game.turn() === playerColor
      ? "Checkmate. You lost."
      : "Checkmate. You won.";
  }
  if (game.isStalemate()) {
    return "Stalemate.";
  }
  if (game.isDraw()) {
    return "Draw.";
  }
  if (game.inCheck()) {
    return game.turn() === playerColor
      ? "You are in check."
      : "KAIROS is in check.";
  }
  return game.turn() === playerColor ? "Your move." : "Engine to move.";
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function kingSquare(color: "w" | "b"): Square | null {
  for (const row of game.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === color) {
        return piece.square;
      }
    }
  }
  return null;
}

function render(): void {
  const files = flipped
    ? ["h", "g", "f", "e", "d", "c", "b", "a"]
    : ["a", "b", "c", "d", "e", "f", "g", "h"];
  const ranks = flipped
    ? ["1", "2", "3", "4", "5", "6", "7", "8"]
    : ["8", "7", "6", "5", "4", "3", "2", "1"];
  const legal = new Set<string>();
  if (selected) {
    for (const move of game.moves({ square: selected, verbose: true })) {
      legal.add(move.to);
    }
  }
  const checked = game.inCheck() ? kingSquare(game.turn()) : null;

  const squares: string[] = [];
  for (const rank of ranks) {
    for (const file of files) {
      const square = `${file}${rank}` as Square;
      const piece = game.get(square);
      const dark =
        (square.charCodeAt(0) - 97 + Number(rank) - 1) % 2 === 0;
      const classes = ["square", dark ? "dark" : "light"];
      if (selected === square) {
        classes.push("selected");
      }
      if (lastMove?.from === square || lastMove?.to === square) {
        classes.push("last-move");
      }
      if (checked === square) {
        classes.push("check");
      }
      if (legal.has(square)) {
        classes.push(piece ? "capture-target" : "move-target");
      }
      const label = piece
        ? `${square}, ${piece.color === "w" ? "white" : "black"} ${PIECE_NAMES[piece.type]}`
        : `${square}, empty`;
      const glyph = piece ? GLYPHS[`${piece.color}${piece.type}`] : "";
      const marker = legal.has(square) ? `<span class="dot"></span>` : "";
      squares.push(
        `<button class="${classes.join(" ")}" type="button" data-square="${square}" ` +
          `aria-label="${label}" aria-pressed="${selected === square}">` +
          `<span class="piece ${piece?.color ?? ""}" aria-hidden="true">${glyph}</span>${marker}</button>`,
      );
    }
  }
  boardEl.innerHTML = squares.join("");
  renderMoves();
  setStatus(statusText());
}

function renderMoves(): void {
  const history = game.history({ verbose: true });
  movesEl.innerHTML = history
    .map(
      (move, index) =>
        `<li><span class="ply">${index + 1}.</span>${move.san}</li>`,
    )
    .join("");
}

function chooseSquare(square: Square): void {
  if (thinking || engineDisabled || !ready || game.isGameOver()) {
    return;
  }
  if (game.turn() !== playerColor) {
    return;
  }
  const piece = game.get(square);
  if (selected) {
    if (square === selected) {
      selected = null;
      render();
      return;
    }
    const candidates = game.moves({
      square: selected,
      verbose: true,
    }) as Move[];
    const candidate = candidates.find((move) => move.to === square);
    if (candidate) {
      if (candidate.promotion) {
        pendingPromotion = { from: selected, to: square };
        promotionEl.showModal();
        return;
      }
      commitMove(selected, square);
      return;
    }
    if (piece && piece.color === playerColor) {
      selected = square;
    } else {
      selected = null;
    }
    render();
    return;
  }
  if (piece && piece.color === playerColor) {
    selected = square;
    render();
  }
}

function commitMove(
  from: Square,
  to: Square,
  promotion?: string,
): void {
  let move: Move;
  try {
    move = game.move({ from, to, promotion });
  } catch {
    return;
  }
  lastMove = { from: move.from, to: move.to };
  selected = null;
  render();
  askEngine();
}

function newGame(): void {
  activeRequest = ++requestCounter;
  thinking = false;
  clearWatchdog();
  hideAlert();
  engineDisabled = false;
  game = new Chess();
  selected = null;
  lastMove = null;
  pendingPromotion = null;
  engineLineEl.textContent = "";
  rationaleEl.textContent = "";
  post({ type: "newgame" });
  render();
  if (engineToMove()) {
    askEngine();
  }
}

boardEl.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-square]",
  );
  if (target?.dataset.square) {
    chooseSquare(target.dataset.square as Square);
  }
});

promotionEl.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-piece]",
  );
  if (target && pendingPromotion) {
    const pending = pendingPromotion;
    pendingPromotion = null;
    promotionEl.close();
    commitMove(pending.from, pending.to, target.dataset.piece);
  }
});

promotionEl.addEventListener("cancel", () => {
  pendingPromotion = null;
});

sideEl.addEventListener("change", () => {
  playerColor = sideEl.value as "w" | "b";
  flipped = playerColor === "b";
  newGame();
});

thinkEl.addEventListener("change", () => {
  thinkTime = Number(thinkEl.value);
});

styleEl.addEventListener("input", () => {
  style = Number(styleEl.value);
  styleValueEl.value = String(style);
  post({ type: "setoption", name: "KairosStyle", value: String(style) });
});

postureEl.addEventListener("change", () => {
  posture = postureEl.value as Posture | "Auto";
  post({ type: "setoption", name: "KairosPosture", value: posture });
});

varietyEl.addEventListener("input", () => {
  variety = Number(varietyEl.value);
  varietyValueEl.value = String(variety);
  post({ type: "setoption", name: "KairosVariety", value: String(variety) });
});

newGameEl.addEventListener("click", newGame);

flipEl.addEventListener("click", () => {
  flipped = !flipped;
  render();
});

alertActionEl.addEventListener("click", () => {
  if (alertActionEl.dataset.action === "newgame") {
    newGame();
    return;
  }
  hideAlert();
  engineDisabled = false;
  clearWatchdog();
  clearInitTimer();
  host.terminate();
  controller.terminate();
  connect();
  render();
});

window.addEventListener("pagehide", () => {
  post({ type: "quit" });
  clearWatchdog();
  clearInitTimer();
  host.terminate();
  controller.terminate();
});

connect();
render();
