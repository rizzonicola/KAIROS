# Personality implementation plan

Goal: implement the KAIROS personality from `KAIROS_SPECIFICATION.md` without
weakening the existing safety guards. Stockfish remains the only source of
candidate moves, legality, and tactical verification.

## Non-goals

- No Stockfish source, search, or NNUE changes.
- No corridor widening to manufacture alternative moves.
- No Elo claim without a controlled SPRT run.
- No anti-cheat evasion.

## Status

| Area | Before | Target |
|---|---|---|
| Postures | Coil only | Six postures, blended mix |
| Features | `F_T`, `F_S`, `F_I` | All nine, probes for `F_N`/`F_P` |
| Inference | None | Evidence, softmax, hysteresis, overrides |
| Opponent model | None | Fragility Profile, EWMA |
| Anti-rigidity | None | Temperature sampling, plan tokens |
| Strength guard | Corridor, band, mate, verification | + cumulative budget, repetition, 50-move |
| Time management | 75% main / 10% verify | 65% main / 25% probes / 10% verify |
| UCI options | `KairosStyle`, `KairosVerbose` | + `KairosPosture`, `KairosVariety` |
| Validation | 34 tests | + feature/posture/scenario tests |
| Calibration | None | Harness + documented results, no invented Elo |

## Milestones

### M1 — Features

Implement the nine features in `kairos/chess_features.py`.

- Cheap: `F_T`, `F_R`, `F_C`, `F_F`, `F_K`, `F_S`, `F_I`.
- Probe: `F_N` (reply narrowness) and `F_P` (prophylaxis) with neutral
  fallback when the probe budget is unavailable.
- Normalize to roughly -1..+1 and document every proxy.
- Acceptance: unit tests for each feature; no move generation or legality
  claims; existing 34 tests still pass.

### M2 — Postures

Add `kairos/postures.py` with the six postures and the specification weight
table.

- `KairosPosture=Auto|Coil|Strike|Absorb|Reverse|Distill|Fog`.
- Score `-loss + 0.1 * style * sum(w_k * F_k)`.
- Acceptance: weight-table test, forced-posture end-to-end test, Coil remains
  the default and still reranks the existing fixture.

### M3 — Inference, softmax, hysteresis, overrides

- Evidence: expected-score band, trend over the last three own moves, king
  pressure, Tension Index, forcing density in PVs, game phase, Fragility
  Profile.
- Softmax blend; plan inertia (margin 0.15, two consecutive moves); immediate
  Strike/Absorb overrides; Distill conversion lock (enter >= 0.80, exit < 0.65).
- Acceptance: deterministic unit tests for each rule; verbose line reports
  posture, confidence, mix, T, N, budget, pick, loss.

### M4 — Opponent model and anti-rigidity

- Fragility Profile: EWMA of the opponent's expected-score loss by position
  class (sharp-tactical, quiet-maneuvering, defending, endgame), using the
  previous PV expectation versus the next search's expectation.
- `KairosVariety` temperature sampling; zero in Strike/Distill and in forced
  situations.
- Acceptance: EWMA/class tests; variety=0 is deterministic; variety>0 never
  bypasses verification.

### M5 — Strength guard and time management

- Rolling 10-move budget cap at 2.5x the single-move budget.
- Repetition and 50-move awareness; skip personality on forced/mate/low-time
  searches and in Distill when clearly winning.
- 65/25/10 time split for long movetime searches; keep the 75/10 split for
  short searches where probes would be unreliable.
- Acceptance: budget cap, repetition, 50-move, and time-split tests.

### M6 — Logging and documentation

- One-line `info string kairos ...` rationale with posture, confidence, mix,
  T, N, budget, pick, loss, and feature values.
- Update README, `docs/IMPLEMENTATION_REPORT.md`, and `CHANGELOG.md`.
- Acceptance: README matches the implemented options and limitations.

### M7 — Validation

- Scenario suite of curated positions with expected posture/behaviour.
- Safety checks: no result-band downgrade, no mate rerank, verification on
  every non-best pick, budget cap.
- Provide a self-play/SPRT harness and document that no Elo result is claimed
  until it is run.
- Acceptance: full test suite passes; scenario results recorded.

### M8 — Release

- Build official Stockfish 19 WASM (`wasm32`, `wasm32-relaxed-simd`) and the
  optional `stockfish.js` Lite/Lite-single artifacts.
- Tag `v0.1.0`, publish the GitHub release, verify archives and `SHA256SUMS`.
- Acceptance: all release assets present and checksummed.

## Working rule

After each milestone: update the status table, run the full suite, and commit.
Do not claim a milestone complete without a test or an explicit limitation.
