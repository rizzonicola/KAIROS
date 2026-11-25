# KAIROS Web

The optional browser page of KAIROS. It runs the same controller and Rust core as the UCI engine, with
Stockfish 19 Lite (single thread) as a Web Worker. Everything happens locally.

```text
kairos-web-<tag>/
  index.html   assets/
  engine/stockfish-19-lite-single.js|.wasm   engine/kairos_core_bg.wasm
  README-WEB.md  LICENSE  THIRD_PARTY.md
```

Serve the directory over HTTP with any static server (opening `index.html` from the filesystem does not load
WebAssembly). Asset paths are relative, so sub-paths work (e.g. GitHub Pages); no COOP/COEP headers and no
`SharedArrayBuffer` are needed.

Controls: side, think time (min 1.5 s for personality searches), Style, Independence, Posture, Variety, New game,
Undo, Flip. The badge shows `Stockfish + KAIROS` or `KAIROS standalone` (Stockfish unavailable or crashed twice).
The rationale panel is compact by default; "Details" shows the plan token, KAIROS proposals versus Stockfish's
top 3, the pressure meter, the posture mix, the nine features and, on a fallback, the guard that fired.

Development: `npm ci`, `scripts/build_core.sh`, `scripts/fetch_engine.sh`, `npm run dev`, `npm test`.
