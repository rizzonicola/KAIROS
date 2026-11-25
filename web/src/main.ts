import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import type { KairosOptions, Rationale } from "./controller";
import { EngineHost } from "./engine-host";
import { applyEngineMove, positionCommand } from "./game";
import type { Posture } from "./postures";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { S } from "./strings";
import type { EngineMode } from "./types";
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

const MIX_ORDER: Posture[] = [
  "Coil",
  "Strike",
  "Absorb",
  "Reverse",
  "Distill",
  "Fog",
];

const FEATURE_LABELS = S.features;

const KIND_LABELS = S.kinds;

app.innerHTML = `
  <main class="shell">
    <header class="masthead">
      <h1>${S.title} <span>${S.subtitle}</span></h1>
      <p class="tagline">${S.tagline}</p>
    </header>
    <div class="layout">
      <section class="board-column">
        <p id="engine-badge" class="engine-badge" data-mode="loading">${S.badge.loading}</p>
        <div id="board" class="board" role="grid" aria-label="Chess board"></div>
        <p id="status" class="status" aria-live="polite">${S.status.loading}</p>
        <p id="engine-line" class="engine-line"></p>
        <div id="error-banner" class="alert" role="alert" hidden>
          <p id="alert-text"></p>
          <button id="retry" type="button">${S.controls.retry}</button>
        </div>
      </section>
      <aside class="panel">
        <div class="controls">
          <label>${S.controls.side}
            <select id="side">
              <option value="w">${S.controls.white}</option>
              <option value="b">${S.controls.black}</option>
            </select>
          </label>
          <label>${S.controls.think}
            <select id="think">
              <option value="1500">1.5 s</option>
              <option value="2000" selected>2 s</option>
              <option value="3000">3 s</option>
              <option value="5000">5 s</option>
              <option value="10000">10 s</option>
            </select>
          </label>
          <label>${S.controls.style} <output id="style-value">50</output>
            <input id="style" type="range" min="0" max="100" step="1" value="50" />
          </label>
          <label title="${S.controls.independenceHint}">${S.controls.independence} <output id="independence-value">50</output>
            <input id="independence" type="range" min="0" max="100" step="1" value="50" />
          </label>
          <label>${S.controls.posture}
            <select id="posture">
              ${POSTURES.map((name) => `<option value="${name}">${name}</option>`).join("")}
            </select>
          </label>
          <label>${S.controls.variety} <output id="variety-value">0</output>
            <input id="variety" type="range" min="0" max="100" step="1" value="0" />
          </label>
          <div class="row">
            <button id="new-game" type="button">${S.controls.newGame}</button>
            <button id="undo" type="button">${S.controls.undo}</button>
            <button id="flip" type="button">${S.controls.flip}</button>
          </div>
        </div>
        <ol id="move-list" class="moves" aria-label="Move list"></ol>
        <section id="rationale" class="rationale" aria-live="polite" aria-label="Move rationale"></section>
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
const alertEl = element<HTMLDivElement>("#error-banner");
const alertTextEl = element<HTMLParagraphElement>("#alert-text");
const alertActionEl = element<HTMLButtonElement>("#retry");
const movesEl = element<HTMLOListElement>("#move-list");
const rationaleEl = element<HTMLElement>("#rationale");
const sideEl = element<HTMLSelectElement>("#side");
const thinkEl = element<HTMLSelectElement>("#think");
const styleEl = element<HTMLInputElement>("#style");
const styleValueEl = element<HTMLOutputElement>("#style-value");
const postureEl = element<HTMLSelectElement>("#posture");
const independenceEl = element<HTMLInputElement>("#independence");
const independenceValueEl = element<HTMLOutputElement>("#independence-value");
const badgeEl = element<HTMLParagraphElement>("#engine-badge");
const undoEl = element<HTMLButtonElement>("#undo");
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
let independence = 50;
let engineMode: EngineMode = "stockfish";
let modeKnown = false;
let thinkTime = 2000;
let selected: Square | null = null;
let lastMove: { from: string; to: string } | null = null;
let pendingPromotion: { from: Square; to: Square } | null = null;

let controller: Worker;
let host: EngineHost;
let ready = false;
let engineDisabled = false;
let thinking = false;
let stackRestarts = 0;
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
    independence,
    allowUnverifiedEngine,
    standalone: engineMode === "standalone",
  };
  post({
    type: "init",
    options,
    seed: Date.now(),
    // Relative to the page, so sub-path hosting keeps working.
    coreUrl: new URL("engine/kairos_core_bg.wasm", document.baseURI).href,
  });
}

function connect(): void {
  controller = new Worker(new URL("./kairos-worker.ts", import.meta.url), {
    type: "module",
  });
  controller.onmessage = (event: MessageEvent<WorkerResponse>) => {
    handleControllerMessage(event.data);
  };
  controller.onerror = (event) => {
    handleControllerFailure(event.message || S.errors.controllerStopped);
  };
  controller.onmessageerror = () => {
    handleControllerFailure(S.errors.controllerUnreadable);
  };

  host = new EngineHost(
    () =>
      new Worker(
        new URL("engine/stockfish-19-lite-single.js", document.baseURI),
      ),
    (line) => post({ type: "engine-line", line }),
    () => handleEngineFailure(S.errors.engineStopped),
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
    case "mode":
      setMode(message.mode, message.reason);
      return;
    case "ready":
      ready = true;
      setMode(message.mode, "");
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
        thinking = false;
        clearWatchdog();
        render();
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
    handleEngineFailure(S.errors.engineNoStart);
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
    watchdog = null;
    handleWatchdogTimeout(S.errors.engineNoAnswer);
  }, milliseconds);
}

function clearWatchdog(): void {
  if (watchdog !== null) {
    window.clearTimeout(watchdog);
    watchdog = null;
  }
}

function handleWatchdogTimeout(message: string): void {
  if (engineDisabled || !thinking) {
    return;
  }
  post({ type: "stop" });
  watchdog = window.setTimeout(() => {
    watchdog = null;
    if (!thinking || engineDisabled) {
      return;
    }
    if (stackRestarts >= 1) {
      host.terminate();
      controller.terminate();
      blockEngine(message, "retry");
      return;
    }
    stackRestarts += 1;
    thinking = false;
    clearInitTimer();
    host.terminate();
    controller.terminate();
    connect();
    render();
    setStatus(S.status.restartingKairos(message));
  }, 2_000);
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
    setStatus(S.status.restartingEngine(message));
    return;
  }
  enterStandalone(message);
}

function setMode(mode: EngineMode, reason: string): void {
  engineMode = mode;
  modeKnown = true;
  updateBadge();
  if (mode === "standalone" && reason) {
    engineLineEl.textContent = S.status.standalone(reason);
  }
}

function updateBadge(): void {
  if (!modeKnown) {
    badgeEl.textContent = S.badge.loading;
    badgeEl.dataset.mode = "loading";
    return;
  }
  badgeEl.textContent = engineMode === "standalone" ? S.badge.standalone : S.badge.stockfish;
  badgeEl.dataset.mode = engineMode;
}

/** Stockfish is gone for good: continue with KAIROS' own search (spec: never just show an error). */
function enterStandalone(reason: string): void {
  clearWatchdog();
  clearInitTimer();
  host.terminate();
  const wasThinking = thinking;
  thinking = false;
  engineMode = "standalone";
  modeKnown = true;
  updateBadge();
  post({ type: "standalone", reason });
  engineLineEl.textContent = S.status.standalone(reason);
  render();
  if ((wasThinking || engineToMove()) && ready) {
    askEngine();
  }
}

function handleControllerFailure(message: string): void {
  if (engineDisabled) {
    return;
  }
  clearWatchdog();
  clearInitTimer();
  thinking = false;
  ready = false;
  if (stackRestarts >= 1) {
    host.terminate();
    controller.terminate();
    blockEngine(message, "retry");
    return;
  }
  stackRestarts += 1;
  host.terminate();
  controller.terminate();
  connect();
  render();
  setStatus(S.status.restartingKairos(message));
}

function blockEngine(message: string, action: "retry" | "newgame"): void {
  clearWatchdog();
  clearInitTimer();
  engineDisabled = true;
  thinking = false;
  newGameEl.disabled = true;
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
    blockEngine(S.status.illegalEngineMove(move), "newgame");
    return;
  }
  lastMove = { from: applied.from, to: applied.to };
  selected = null;
  showRationale(rationale);
  render();
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

function bar(width: number): string {
  const clamped = Math.max(0, Math.min(100, width));
  return `<span class="bar" aria-hidden="true"><i style="width:${clamped.toFixed(1)}%"></i></span>`;
}

function showRationale(rationale: Rationale): void {
  const mixRows = MIX_ORDER.map((name) => {
    const value = rationale.mix[name] ?? 0;
    return `<li><span>${name}</span>${bar(value * 100)}<span class="row-value">${Math.round(value * 100)}%</span></li>`;
  }).join("");
  const featureRows = rationale.features
    ? `<div class="rationale-block"><h3>${S.rationale.features}</h3><ul class="bars">` +
      FEATURE_LABELS.map(([key, label]) => {
        const value = rationale.features![key];
        return `<li><span>${label}</span>${bar(((value + 1) / 2) * 100)}<span class="row-value">${value.toFixed(2)}</span></li>`;
      }).join("") +
      `</ul></div>`
    : "";
  const reason = escapeHtml(rationale.reason.replaceAll("-", " "));
  const list = (moves: string[]): string =>
    moves.length > 0 ? escapeHtml(moves.join(" ")) : S.rationale.none;
  const plan = rationale.planToken;
  const planText = plan
    ? `${escapeHtml(plan.intent)} · ${escapeHtml(plan.target)} (${escapeHtml(plan.files)})` +
      (plan.levers.length ? ` · levers ${escapeHtml(plan.levers.join(" "))}` : "") +
      (plan.reserve.length ? ` · reserve ${escapeHtml(plan.reserve.join(" "))}` : "")
    : escapeHtml(rationale.plan);
  const tension = rationale.pressure ? rationale.pressure.tension : 0;
  const narrowness = rationale.pressure?.narrowness ?? null;
  const pressure =
    `<div class="rationale-block"><h3>${S.rationale.pressure}</h3><ul class="bars">` +
    `<li><span>${S.rationale.tension}</span>${bar((Math.min(12, tension) / 12) * 100)}<span class="row-value">${tension}</span></li>` +
    (narrowness === null
      ? ""
      : `<li><span>${S.rationale.narrowness}</span>${bar(((narrowness + 1) / 2) * 100)}<span class="row-value">${narrowness.toFixed(2)}</span></li>`) +
    `</ul></div>`;
  const guard =
    rationale.kind === "fallback" || rationale.kind === "stockfish"
      ? `<p class="rationale-guard">${S.rationale.guard}: <code>${reason}</code></p>`
      : "";
  const origin =
    rationale.kind === "standalone"
      ? ""
      : `<p class="rationale-lines">
          ${S.rationale.proposed}: ${list(rationale.proposed)}<br />
          ${S.rationale.top3}: ${list(rationale.sfTop3)}<br />
          ${rationale.outsideTop3 ? S.rationale.outside : S.rationale.inside}${rationale.playedProposed ? " · KAIROS proposed" : ""}
        </p>`;
  rationaleEl.dataset.kind = rationale.kind;
  rationaleEl.innerHTML = `
    <div class="rationale-head">
      <span class="badge badge-${rationale.kind}">${KIND_LABELS[rationale.kind]}</span>
      <strong>${rationale.posture}</strong>
      <span class="rationale-plan">${escapeHtml(rationale.plan)} · ${reason}</span>
    </div>
    <p class="rationale-summary">
      ${S.rationale.confidence} ${Math.round(rationale.confidence * 100)}% ·
      ${S.rationale.budget} ${rationale.budgetPct.toFixed(2)}% ·
      ${S.rationale.loss} ${rationale.lossPct.toFixed(2)}% ·
      ${S.rationale.pick} ${rationale.pick} ·
      ${S.rationale.stockfish} ${escapeHtml(rationale.sfBest || S.rationale.none)}
    </p>
    ${guard}
    <details class="rationale-more">
      <summary>${S.rationale.more}</summary>
      <p class="rationale-plan-text"><strong>${S.rationale.plan}:</strong> ${planText}</p>
      ${origin}
      ${pressure}
      <div class="rationale-block"><h3>${S.rationale.posture}</h3><ul class="bars">${mixRows}</ul></div>
      ${featureRows}
    </details>`;
}

function statusText(): string {
  if (engineDisabled) {
    return S.status.disabled;
  }
  if (thinking) {
    return S.status.thinking;
  }
  if (!ready) {
    return S.status.loading;
  }
  if (game.isCheckmate()) {
    return game.turn() === playerColor ? S.status.youLost : S.status.youWon;
  }
  if (game.isStalemate()) {
    return S.status.stalemate;
  }
  if (game.isDraw()) {
    return S.status.draw;
  }
  if (game.history().length === 0 && game.turn() === playerColor) {
    return S.status.ready;
  }
  if (game.inCheck()) {
    return game.turn() === playerColor ? S.status.youInCheck : S.status.engineInCheck;
  }
  return game.turn() === playerColor ? S.status.yourMove : S.status.engineMove;
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
  if (engineDisabled) {
    return;
  }
  activeRequest = ++requestCounter;
  thinking = false;
  clearWatchdog();
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
  if (engineDisabled) {
    sideEl.value = playerColor;
    return;
  }
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

independenceEl.addEventListener("input", () => {
  independence = Number(independenceEl.value);
  independenceValueEl.value = String(independence);
  post({ type: "setoption", name: "KairosIndependence", value: String(independence) });
});

/** Take back the last move pair (the engine's reply and the player's move before it). */
function undoMovePair(): void {
  if (thinking || engineDisabled || !ready) {
    return;
  }
  if (game.history().length === 0) {
    return;
  }
  const undoOne = (): void => {
    if (game.history().length > 0) {
      game.undo();
    }
  };
  if (game.turn() === playerColor) {
    undoOne(); // the engine's move
    if (game.turn() !== playerColor) {
      undoOne(); // the player's move
    }
  } else {
    undoOne();
  }
  selected = null;
  const history = game.history({ verbose: true });
  lastMove = history.length ? { from: history[history.length - 1].from, to: history[history.length - 1].to } : null;
  rationaleEl.textContent = "";
  engineLineEl.textContent = "";
  render();
  if (engineToMove()) {
    askEngine();
  }
}

undoEl.addEventListener("click", undoMovePair);

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
  const resetBoard = alertActionEl.dataset.action === "newgame";
  hideAlert();
  engineDisabled = false;
  stackRestarts = 0;
  newGameEl.disabled = false;
  clearWatchdog();
  clearInitTimer();
  thinking = false;
  host.terminate();
  controller.terminate();
  connect();
  if (resetBoard) {
    newGame();
  }
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
