# KAIROS: The Tension Economist

*Chess engine personality specification · v1.0 · Written for handoff to a software engineering agent*

## 0. Summary and design contract

Kairos is a personality layer wrapped around single-thread Stockfish. It does not try to out-evaluate Stockfish. It chooses among moves Stockfish already considers practically equal, guided by one strategic conviction: **tension is capital, and pressure compounds**. It keeps the board unresolved while that is profitable, narrows the opponent’s safe options, and releases the position at the moment the release pays most.

Four design rules hold throughout:

1. **Stockfish decides what is allowed.** A Soundness Corridor, measured in expected score, bounds every choice.
2. **Kairos decides what is preferred.** Inside the corridor, a personality score picks the move.
3. **Behavior emerges from posture.** Six soft strategic postures are inferred from the position. There are no hard-coded opening or move rules.
4. **No retraining.** The stock NNUE network stays untouched. Everything is search-side reranking, cheap feature extraction and light online modeling.

## 1. Name and identity

- **Name:** KAIROS (Greek for the decisive, opportune moment)
- **Epithet:** The Tension Economist
- **Motto:** *Pressure compounds. Release is a decision.*
- **Character:** patient, dignified, economical. It treats the game as a negotiation with time: it never rushes a resolution, never wastes a tempo on show, and never hesitates once the moment arrives.
- **What it feels like to face:** For several moves nothing seems to happen. Every option you have still exists, yet fewer of them are good each turn. Then the position opens on Kairos’s terms and the outcome is already largely decided.
- **Originality:** The identity rests on a measurable quantity (tension) and an investment metaphor (hold, accrue, release). It does not imitate any human player or existing engine style.

## 2. Central philosophy: The Tension Doctrine

1. **Tension is potential energy.** Unresolved pawn levers, pending captures, pins, closed-but-breakable files and undeployed pieces all store options. Resolving them early converts options into a fixed structure and hands the opponent clarity.
2. **Pressure compounds.** Each move that leaves the opponent a narrow path (few acceptable replies, a heavy penalty for the wrong one) raises the chance of error later. Small edges in narrowness add up.
3. **Release is a decision, not a reflex.** Capturing, advancing a lever, trading queens or opening a file requires that its *release value* beat its *hold value*.
4. **Risk is metered, never faith-based.** Every concession is paid from an explicit budget and must buy a named asset.
5. **Posture follows position.** The approach is an inference from the board and the opponent’s behavior, never a fixed temperament.

**Core quantities** (implementation in section 11):

| Term | Meaning |
| --- | --- |
| Tension Index (T) | Count of mutually live conflicts: pawn levers, captures with near-zero exchange value (SEE close to 0), pins and x-rays, contested key files. |
| Narrowness (N) | How hard the opponent’s next decision is: a low share of near-best replies and a large gap between best and second-best reply. |
| Reserve (R) | Pieces still uncommitted, with at least two distinct improving squares. |
| Release value | Expected score after resolving a tension minus expected score after holding it, both with best play. |
| Soundness Corridor | Candidate moves whose expected-score loss versus Stockfish’s best is within the current budget. |
| Budget (B) | Maximum expected-score loss Kairos may accept this move. Depends on posture and game state. |

## 3. Defining behavioral characteristics

- **Unhurried.** Prefers useful waiting and improving moves over early resolution.
- **Elastic.** Prefers structures with several viable breaks over structures with one.
- **Narrowing.** Seeks positions where the opponent must find precise moves.
- **Economical.** Avoids committal pawn moves, exchanges or placements that can be delayed at no cost.
- **Honest about risk.** Takes calculated concessions only inside a budget, and records them in its logs.
- **Self-correcting.** Switches posture when evidence demands it, with hysteresis so it does not flip-flop.
- **Dignified.** Avoids pure swindles when the position is healthy. Uses chaos only when objectively behind.

Additional dimensions that give it depth:

- **Temporal character.** Spends more time on releases and sacrifices. Plays quickly on forced, prophylactic and one-move-corridor decisions.
- **Plan inertia.** Holds a plan for several moves through a *plan token* (target area, breakers, reserve pieces), so its play reads as coherent.
- **Reserve discipline.** Keeps at least one piece unrevealed until the critical moment.
- **Opponent reading.** Tracks where the opponent loses accuracy (sharp, quiet, defending, endgames) and steers toward that terrain without leaving the corridor.
- **Controlled variety.** Chooses with a small temperature among near-equal moves so repetition cannot exploit it.
- **Explainability.** Emits a one-line rationale per move (posture, T, N, budget used).

## 4. Attacking and defensive mentality

### Attack: tightening before storming

- Builds an attack by increasing the number of *live lines* toward the king zone before opening any of them.
- Opens a line only when the *arrival count* (own pieces that can join within two moves) exceeds the defenders available to meet them.
- Treats initiative as a stock, not a flow. It spends initiative to buy a lasting asset (an exposed king, an open file, a structural weakness), not on repetitive checks.
- Prefers quiet moves that make two threats, or one threat plus an improvement, over single-threat forcing moves.
- Enters full Strike only when Stockfish’s lines show the forcing sequence holding up under verification.

### Defense: absorb, shadow, reverse

- **Absorb.** Gives ground (space, a structural compromise) to keep pieces coordinated and the king safe, rather than clinging to every square.
- **Prophylactic shadowing.** Each move asks: what would the opponent do if I passed? It prefers moves that remove the opponent’s best plan (null-move threat probe) over reacting after the fact.
- **Reverse.** Watches for overextension: a released tension that left loose pieces, weakened squares or a king without shelter. When swing potential appears it counterattacks, using the *counter-hinge*: the move that turns a defensive concession into tempo.
- **Fog (when worse).** Keeps queens and tension on, avoids simplification, and picks lines where the opponent must find a chain of only-moves, staying inside a wider but still bounded budget.

## 5. Positional preferences

**Pawn structure**

- Prefers unresolved centers and flexible levers (two or more possible breaks) over early fixation.
- Avoids locking the position unless Kairos has the better breaker or the better pieces for the closed structure.
- Accepts structural concessions (isolated, hanging or doubled pawns) only when paired with piece activity and retained tension.
- Treats a protected advanced or passed pawn as a long-term asset, not something to rush.

**Pieces**

- Values coordination (batteries, mutual protection, shared target squares) over raw individual activity.
- Likes knights on stable outposts and bishops on long diagonals. Values the bishop pair in positions that can still open.
- Delays rook commitment until a file is about to open, then lifts or doubles decisively.
- Keeps the queen flexible. Trades it only in Distill posture or when the resulting endgame is clearly better.

**King**

- Safe by default (positive safety margin in Coil, Absorb and Distill).
- Tolerates delayed or unusual castling when the center is closed or central tension favors Kairos.
- In Strike, accepts a thinner shelter in exchange for tempo, never beyond the budget.

**Space, files and time**

- Prefers to own the file that is *about to open*, not the one that is open now.
- Values spare tempi (available waiting moves) in structures with mutual-zugzwang flavor.

**Endgames**

- Prefers endgames with a lasting pull (better king, better structure, active rook) and converts them through Distill.

## 6. Risk and sacrifice philosophy

**Bounded Risk Doctrine.** Kairos accepts a small, explicit loss of expected score if the move buys a named, verifiable asset. Loss is measured with Stockfish’s WDL expected score, not raw centipawns, because the same centipawn figure means different things in different positions.

| Situation (posture) | Budget |
| --- | --- |
| Clearly winning, converting (Distill) | ≈ 0.5% |
| Defending, king under pressure (Absorb) | ≈ 1% |
| Balanced, building (Coil) | ≈ 1.5% |
| Counter-chance (Reverse) | ≈ 2% |
| Confirmed attack window (Strike) | ≈ 3% |
| Objectively worse (Fog) | ≈ 4% |

Rough scale: 1% of expected score is about 6–10 cp near equality. Calibrate empirically against the shipped Stockfish version.

**Material as liquidity.** Material is a currency, not a goal. Kairos will spend small amounts for tension, initiative or reserve pieces, and refuses trades that convert tension into a fixed structure.

**Sacrifice classes (in order of preference)**

1. Structural concessions (pawn structure, tempo, space).
2. Pawn sacrifices that keep or open tension.
3. Exchange sacrifices that keep pieces on the board and fix a lasting weakness.
4. Piece sacrifices: only inside the budget and with a verified return path (forced material return, or a perpetual-check floor).

**Sacrifice test (all must hold):** (a) the move is inside the corridor; (b) it buys a named asset (exposed king, passed pawn, lasting file, only-move chain); (c) Narrowness rises meaningfully; (d) a deeper Stockfish verification confirms a draw-or-better floor; (e) the engine is not in Distill.

**Never:** cross a result band (win to draw, draw to loss) for style. Play a move that fails verification. Sacrifice where the opponent’s simplest reply neutralizes the asset.

## 7. Adaptive decision-making principles

### 7.1 Postures

Six soft postures, each a weight vector over the personality features (table in 11.4).

| Posture | Intent | Typical triggers |
| --- | --- | --- |
| Coil | Accumulate tension, improve, wait for the release moment | Balanced, tension available, no immediate attack window |
| Strike | Convert accumulated pressure into forcing play | Attack window confirmed, arrival count exceeds defenders, trend rising |
| Absorb | Defend through coordination and prophylaxis | King under pressure, high opponent threat value |
| Reverse | Turn defense into counterattack | Opponent released tension and left loose pieces or a thin king |
| Distill | Simplify toward a clean advantage | Clearly better; risk should fall |
| Fog | Complicate while objectively worse | Expected score below roughly 35% with no safe consolidation |

### 7.2 Posture inference

Evidence computed each move: expected-score band, trend over the last three own moves, king-zone attackers versus defenders for both sides, Tension Index and who benefits from release, opponent threat value (null-move probe), forcing-move density in Stockfish’s PVs, game phase, and the opponent Fragility Profile (7.4). Posture weights come from a softmax over the evidence scores, so postures blend (for example 60% Coil, 40% Absorb) instead of toggling.

### 7.3 Hysteresis and overrides

- **Plan inertia:** a new posture takes over only if it beats the current one by margin m for k consecutive moves (defaults m = 0.15, k = 2).
- **Immediate overrides:** a confirmed tactical window (Strike) or a serious threat (Absorb) may switch at once.
- **Conversion lock:** after Distill is entered with expected score above \~80%, only a drop below \~65% exits it.

### 7.4 Opponent modeling

After each opponent move, compute its expected-score loss relative to what Kairos’s own search considered best. Keep exponentially weighted averages by position class (sharp-tactical, quiet-maneuvering, defending, endgame) and by narrowness. This is the **Fragility Profile**. It only tilts posture weights: if the opponent loses accuracy in quiet maneuvering, favor Coil. If the opponent is precise in sharp positions, damp Strike and Fog. Per-game by default, optional persistence across games.

### 7.5 Anti-rigidity

Temperature τ = 0 in forced, Strike and Distill situations, and a small positive τ in Coil and Absorb for variety. Plan tokens expire when the structure changes materially.

## 8. Distinctive strategic habits (the tells)

1. **The Late Release.** Declines the obvious capture or lever advance, makes a useful move instead, and resolves only when the opponent’s replies become forced or the opponent has just committed.
2. **The Reserve Piece.** One minor or major piece stays uncommitted until the decisive moment, then enters from an unexpected direction.
3. **The Shadow Move.** A quiet move that removes the opponent’s best next idea. It often looks passive.
4. **Quiet Debt.** Pays a small concession (a tempo, a slightly worse structure) to keep the position unresolved, then collects later.
5. **Exchange for Air.** Gives up the exchange not to attack immediately, but to leave the opponent’s pieces without good squares while its own pieces and tension remain.
6. **Queen Retention.** Refuses queen trades except in Distill or when the endgame is clearly favorable.
7. **Edge Probe.** Uses flank pawn moves as tension-adders or waiting moves rather than permanent commitments.
8. **Time Signature.** Quick, calm replies in quiet phases and a visibly deeper think before releases and sacrifices.

## 9. Strengths and weaknesses

**Strengths**

- Keeps Stockfish’s tactical floor: nothing is played outside the corridor.
- Excels at sustained pressure and long-term structural squeezes.
- Hard to prepare against (varied, tension-based, posture-blending).
- Computationally cheap: mostly bitboard features and shallow probes.
- Explainable move by move.

**Weaknesses (accept and measure them)**

- **Hesitation tax.** Holding tension can let the opponent resolve it on their terms, or let the best release moment pass.
- **Dead positions.** With no tension there is little for the personality to act on, and it plays like plain Stockfish.
- **Forcing tactics.** In highly forcing lines Kairos is essentially vanilla. Style cannot add strength.
- **Probe overhead.** MultiPV and probes cost roughly 1–2 plies of main-search depth at equal time, so expect a modest Elo cost.
- **Narrowness is a model.** Against opponents who are precise in quiet positions, the narrowing strategy yields little.
- **Budget leakage.** Many small budget spends can accumulate. The guards in 7.3 and 11.5 exist to stop this.

## 10. Examples of personality in action

1. **Central pawn tension, balanced middlegame.** Vanilla may capture. Kairos plays a reserve-improving move (rook to the central file, a knight reroute) because release value is below hold value. When the opponent finally commits a piece, it releases.
2. **King under pressure.** The opponent masses pieces on the kingside. In Absorb, Kairos does not counter-lunge on the other wing. It plays the shadow move that removes the opponent’s best break and keeps its pieces coordinated around the king.
3. **Opponent overextends.** After a release that leaves a loose bishop and a draughty king, Reverse activates. The counter-hinge move gains a tempo against the loose piece, then the reserve piece joins.
4. **Slightly worse, queens on.** Fog declines a queen trade that vanilla might accept. It picks a line inside a 4% budget that leaves the opponent a chain of only-moves.
5. **Clearly winning endgame.** Distill: the budget collapses to 0.5%, it simplifies, avoids cute ideas, and plays prophylaxis against counterplay.
6. **Attack window.** Arrival count exceeds defenders and Stockfish confirms the forcing line. In Strike, Kairos finally plays a pawn lever it has kept in reserve for ten moves.
7. **Opponent profile.** The opponent has been inaccurate in the last four quiet middlegame decisions. Coil weight rises and Kairos avoids a sharp variation it would otherwise consider.
8. **Opening.** Prefers flexible setups that retain central tension and several pawn breaks, avoiding early irreversible commitments. An optional weighted book can favor such lines.

## 11. Implementation recommendations

### 11.1 Architecture

A **UCI shell** sits between the GUI and an unmodified single-thread Stockfish process (Threads = 1, Hash 16–64 MB, stock NNUE). Kairos is a separate process or library. Stockfish is a subprocess queried with MultiPV and short child searches. Components: UCI proxy, position and feature extractor, posture engine, candidate reranker, opponent model, verifier, logger.

A Python prototype with python-chess is fine. Use Rust or C++ for production. A later optional Stockfish fork can hook into root-move selection at the end of the search. Stockfish’s Skill Level mechanism already forces multi-PV and picks among root moves, which is a natural template.

### 11.2 Per-move pipeline

1. Run the main search with MultiPV = 5 (or fewer), recording WDL and PVs.
2. Build the corridor: candidates whose expected-score loss versus the best move is at most B (from the current posture mix and state).
3. If the corridor has one move, a forced mate exists, or time is tight, play Stockfish’s best.
4. Compute cheap features for all corridor candidates, and probe features for the top K = 4.
5. Score each: `Score(m) = −λ·Loss(m) + Σ w_k(posture)·F_k(m)`. Choose the argmax, or sample with softmax at temperature τ.
6. Verify: if the pick differs from Stockfish’s best, re-search it at depth + 2 (or double the time). If its loss exceeds B or it crosses a result band, fall back to the next candidate, then to Stockfish’s best.
7. Update the opponent model, plan token and posture state, and emit the log line.

### 11.3 Features

Each is normalized to roughly −1…+1, computed after the candidate move from Kairos’s side.

| Feature | Definition | Cost |
| --- | --- | --- |
| `F_T` Tension | Change in Tension Index. Penalty if a lever is resolved while release value ≤ 0. | Cheap (bitboards, SEE) |
| `F_N` Narrowness | From a MultiPV = 3 child search: 1 − share of replies within 5% of best, plus a bonus if the best-to-second gap exceeds 10%. | Probe |
| `F_R` Reserve | Count of uncommitted pieces with at least two improving squares. | Cheap |
| `F_C` Coordination | Batteries, mutual protection, attacks on king-zone and key squares. | Cheap |
| `F_F` Flexibility | Safe mobility plus retained pawn breaks. | Cheap |
| `F_P` Prophylaxis | Reduction of the opponent’s null-move threat value (skip when in check). | Probe |
| `F_K` King margin | Own king-zone defenders minus attackers. | Cheap |
| `F_S` Simplification | Queen and piece trades, material reduction. | Cheap |
| `F_I` Initiative | Difference in forcing-move count (checks, SEE ≥ 0 captures, threats). | Cheap |

### 11.4 Posture weights (initial values, tune by self-play)

| Feature | Coil | Strike | Absorb | Reverse | Distill | Fog |
| --- | --- | --- | --- | --- | --- | --- |
| `F_T` | 2 | 1 | 1 | 1 | −2 | 2 |
| `F_N` | 2 | 1 | 1 | 1 | 0 | 3 |
| `F_R` | 2 | 0 | 1 | 1 | 0 | 1 |
| `F_C` | 1 | 3 | 0 | 2 | 0 | 1 |
| `F_F` | 2 | 0 | 2 | 1 | 1 | 1 |
| `F_P` | 1 | 0 | 3 | 1 | 3 | 0 |
| `F_K` | 1 | 0 | 3 | 1 | 2 | 0 |
| `F_S` | −1 | −1 | 1 | −1 | 3 | −3 |
| `F_I` | 1 | 3 | 0 | 2 | 0 | 1 |

Scale so one unit of weight is worth roughly 0.1% of expected score, with λ = 1 per percent of loss. The personality should be able to reorder near-equal moves but never dominate the loss term.

### 11.5 Strength Guard

- **Result-band guard:** never move from winning to drawing, or drawing to losing, for style.
- **Mate guard:** if any mate score appears, play Stockfish’s best.
- **Verification** (11.2, step 6) on every non-best pick.
- **Cumulative budget meter:** track expected score spent over a rolling 10-move window and cap it at 2.5× the single-move budget.
- **Repetition and 50-move awareness:** avoid repetition when better, and accept draws only when Stockfish’s evaluation says the draw is the best available result.

### 11.6 Time management

Of each move’s allocation, about 65% goes to the main MultiPV search, 25% to probes (child searches for the top K and one null-move probe), and 10% to verification. Skip the personality entirely (play Stockfish’s best) on forced moves, mate scores, very low time, and in Distill when the best move is already clearly winning.

### 11.7 UCI interface

Options: `KairosStyle` (0–100, scales budgets and weights; 0 = vanilla Stockfish), `KairosPosture` (Auto or forced), `KairosVariety` (τ scale), `KairosVerbose`. Log each move as an info string, for example: `info string kairos posture=COIL conf=0.71 T=7 N=0.58 budget=1.5% pick=2/5 sf_best=Nf3 loss=0.4%`

### 11.8 Validation

- **Strength:** cutechess-cli on identical hardware, one thread, SPRT versus vanilla Stockfish. Target: no more than about 30 Elo lost at equal time. `KairosStyle = 0` must match vanilla.
- **Identity fingerprint:** over 500+ games, Kairos must differ from vanilla at p < 0.01 on average Tension Index at plies 20–40, late-release rate (captures delayed two or more moves when available), mean opponent narrowness, queen-trade timing, and exchange sacrifices per 100 games.
- **Safety:** blunder rate (eval drop above 150 cp, per 1000 moves) no more than vanilla plus 0.5.
- **Scenario suite:** about 200 curated positions (tension-rich, attack window, worse, won endgame, prophylaxis needed) with expected posture and behavior checks.

### 11.9 Roadmap

0. UCI passthrough with logging, verified zero strength loss.
1. Corridor plus MultiPV reranker with three features (T, S, I) and a fixed posture.
2. Full feature set and posture engine with hysteresis.
3. Probes (narrowness, null-move prophylaxis) and verification.
4. Opponent model and tuning (SPSA or grid search under the Elo and identity constraints).
5. Optional Stockfish fork hook, opening book flavor, user-facing explanations.

### 11.10 Open questions for the implementer

- Calibrate budgets against the WDL model of the Stockfish version actually shipped.
- Set per-feature normalization from data (distribution over a sample of master and engine games).
- Decide whether a fork is worth it after Phase 4 measurements.

---

# Appendix: v0.3 evolution (own candidates, Stockfish as judge)

This appendix supersedes statements above that say Stockfish is the only source of candidate moves.

**Architecture.** A Rust core (board service, real SEE/features, plan token, candidate proposer, small
interruptible search) behind the `KairosCore` interface, a TypeScript controller (UCI state machine and
staged pipeline), and unmodified Stockfish 19 Lite. See `docs/ADR-0001-architecture.md`.

**Per-move pipeline.** (1) Gate: style 0, unsupported limits, forced moves, mate scores, Distill conversion
(expected >= 0.90) -> Stockfish's best. (2) Baseline: MultiPV 3 with WDL; meanwhile the core updates the plan
token and proposes up to 12 candidates from the plan and the nine features. (3) Judge: one
`go ... searchmoves <top-3 + proposals>` with MultiPV = number of moves, so every comparison comes from the
same search (same depth, exact scores, WDL). Independence sets how many proposals join (round(I/100 x 7)).
(4) Corridor and scoring: loss <= posture budget x style/100, rolling 10-move cap 2.5x, result-band guard,
saturation margin, repetition/50-move guards; `Score = -loss(pct) + style/100 x (1 + I/100) x 0.1 x sum w_k F_k`.
(5) Probes (>= 3000 ms or depth >= 6) for F_N and F_P. (6) Verification: re-search the pair at depth + 2 (or 14-15%
of the time); failure tries the next candidate (only when time was budgeted) and then Stockfish's best.
(7) Rationale: posture mix, plan token, KAIROS-proposed vs Stockfish top 3, verified loss, budget, guard.

**Postures budgets** (invariant): Coil 1.5%, Strike 3%, Absorb 1%, Reverse 2%, Distill 0.5%, Fog 4%, times
style/100; rolling cap 2.5x. v0.2.1 applied the Coil value to every posture; 0.3 applies the table.

**Features** are real (SEE, attack maps, x-rays, pins, king zones, batteries) and are deltas of the candidate
versus the current position where that discriminates between candidates: `docs/FEATURES_CHANGELOG.md`.

**Plan token** (`plan.rs`): posture intent, target flank, levers (pawns with a break), reserve pieces; persists
across moves and expires when a pawn disappears, two or more pieces come off, or after 16 moves.

**Standalone mode:** own search only (iterative deepening, PVS, TT, quiescence); no personality. Scope guard:
the own search is not tuned for strength and must not be.

**Invariants** are unchanged (section 6 of the task): style 0 equals Stockfish; every uncertainty returns
Stockfish's best; expected score = (W + D/2)/1000; bands 0.45/0.55; saturation 50 cp; every played non-best move
has a verified loss within the effective budget (enforced by `assertSafety` in the tests); the engine and
network are never modified; no strength claims without recorded matches.
