# KAIROS Web Lite

KAIROS Web Lite is a standalone browser page that plays the KAIROS personality
around Stockfish 19 Lite single-threaded WebAssembly. It needs no Python, no
backend, no `SharedArrayBuffer`, and no COOP/COEP headers.

## Run it

Extract the archive and serve the directory with any static file server:

```bash
tar -xzf kairos-lite-web-v0.2.1.tar.gz
cd kairos-lite-web-v0.2.1
python3 -m http.server 8000
```

Open <http://localhost:8000>. The page must be served over HTTP; opening
`index.html` directly from the filesystem does not load the WebAssembly engine.
Subpaths work because every asset path is relative.

## Play

- You play White by default; the engine plays Black.
- Click or tap a piece, then a highlighted destination.
- Think time is 2000 ms by default. The UI offers 1500, 2000, 3000, 5000 and
  10000 ms, with a 1500 ms floor for personality searches.
- Style ranges from 0 to 100. At 0 the page returns Stockfish's exact best move.
- Posture Auto lets KAIROS infer a posture; the other values force one.
- Variety 0 selects the best personality candidate; higher values sample
  seed-deterministically.
- New game resets the board and the rolling budget.

Every engine move carries a rationale panel: the posture and plan, confidence,
the posture mix, the rolling budget, the measured expected-score loss, the
selected candidate, and the nine personality features when a rerank is
verified. A rerank names the verified loss. A fallback returns Stockfish's
exact best move and names the guard that fired. No Elo or strength claim is
made.

## Engine provenance

The archive bundles `stockfish-19-lite-single.js` and
`stockfish-19-lite-single.wasm`, the Lite single-threaded build produced by
[`nmrugg/stockfish.js`](https://github.com/nmrugg/stockfish.js) `v19.0.1` from
upstream Stockfish 19. It uses the Lite network (`nn-61e7af4bb97d.nnue`), not
the original network used by the native KAIROS engine. Stockfish is licensed
under the GNU GPL v3; see `LICENSE` and `THIRD_PARTY.md` in the archive.
Stockfish is the only WebAssembly compute in the page.

## Development

```bash
cd web
npm install
npm test                 # unit, parity and controller tests
npm run build            # typecheck and production build
npm run test:browser     # Playwright smoke and state-machine tests (after a build)
```

Build the release archive from the repository root:

```bash
KAIROS_LITE_ENGINE_DIR=/path/to/stockfish-19-lite-single ./scripts/build_web.sh v0.2.1
```

## Performance

Measured on the reference build (Task 11):

| Measurement | Result |
| --- | --- |
| Feature evaluation | 0.58 ms per fixture position (36 candidates, 6.96 ms total) |
| Browser think time (2000 ms setting) | 1515 ms, engine ready in 97 ms |
