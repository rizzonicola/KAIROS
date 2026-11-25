# Features changelog (v0.2.1 proxies -> v0.3 real features)

`web/tests/vectors/legacy-v0.2.1/features.json` was produced by the Python implementation of the static
proxies. It is **frozen and intentionally no longer enforced**. `web/tests/vectors/v0.3/features.json`
is the new numeric fixture, generated from the Rust/WASM core on 2026-11-25 (10 positions, 29 moves) and
checked by `web/tests/core.test.ts`. The two differ wherever a definition changed; the definitions below
are the reference, not the old numbers.

All features are computed on the mailbox of the position *after* the candidate, from the mover's point
of view, with real attack maps and SEE (`kairos-core/src/features.rs`, `attacks.rs`).

| Feature | v0.2.1 proxy | v0.3 definition | Intentional difference |
|---|---|---|---|
| `T` Tension Index | count of attacked/defended pieces and levers | pawn levers + near-zero-SEE piece conflicts (`|SEE| <= 60 cp`) + pins/x-rays against more valuable pieces + contested open files, cap 12 | exchanges are scored by real SEE, x-rays through pieces are seen |
| `F_T` | change in T, penalty on capture | change in T / 4 (clamped), minus 0.25 when the move resolves a lever or captures with SEE <= 0 | "release value" is SEE-based, not the old material delta |
| `F_N` | probe | probe (unchanged, Stockfish child search); 0 in the core | none |
| `F_R` Reserve | pieces with >= 2 non-attacked squares | pieces still at home (first two ranks; rooks also on pawn-closed files) with >= 2 safe destinations (landing SEE loss = 0), /5 | "uncommitted" is a rank proxy, "safe" uses SEE |
| `F_C` Coordination | mutual protection + zone attacks | change of (mutual protection + king-zone attackers + 2 x batteries), /6 | batteries (same-line sliders) are real; delta instead of level |
| `F_F` Flexibility | (mobility + 3 breaks)/20, saturated | change of (safe mobility + 3 x pawn breaks), /12 | safe mobility uses SEE; delta avoids saturation at 1.0 |
| `F_P` | probe | probe (unchanged) | none |
| `F_K` King margin | (defenders - attackers)/8 level | change of (defenders - attackers) of the 3x3 king zone, /4 | delta, so waiting moves rank by what they change |
| `F_S` Simplification | captured value / 9 | traded material of capture + recapture (if any) / 9 pawns, +0.3 when queens come off | recapture is looked up, queen trades weigh more |
| `F_I` Initiative | forcing density of the PV | change of (my forcing moves - their forcing moves), /6, +1 when the move gives check; forcing = checks + captures with SEE >= 0 + at most one quiet threat per piece | static count of forcing moves instead of PV density; PV density is still used for the opponent model (`forcing_density`) |

Normalisation (deltas, scales) is an engineering convention and is **uncalibrated**; change it only with
measurements recorded in `docs/VALIDATION.md`. The personality term is
`style/100 x (1 + independence/100) x 0.1 x sum(w_k F_k)` percentage points (the `(1 + independence/100)`
factor is new in 0.3 and also uncalibrated).
