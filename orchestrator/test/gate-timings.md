# Gate timings

Measurements for DEV-347. Each section is written when taken so a cut-off run still leaves evidence.

Raw JSON (gitignored): `orchestrator/runs/gate-timings/<stamp>.json`.

## 1. Instrument — full CLI leg

- stamp: `2026-09-07T11-58-04-992Z`
- command: `bun test .cli.test.ts`
- elapsed: 327.4 s (exit 0)
- tests: 831 (831 pass, 0 fail)
- process calls: 8555 (spawn + spawnSync); database bootstraps: 9

### Per-file totals

| file | wall s | tests | fail | spawn | spawnSync | bootstraps | cli | git | other |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| src/landing-1.cli.test.ts | 57.47 | 45 | 0 | 39 | 881 | 0 | 2 | 869 | 49 |
| src/lifecycle-harness.cli.test.ts | 23.80 | 26 | 0 | 62 | 896 | 3 | 21 | 875 | 62 |
| src/worktree-2.cli.test.ts | 22.56 | 37 | 0 | 6 | 530 | 0 | 23 | 466 | 47 |
| src/cli-answer.cli.test.ts | 17.88 | 22 | 0 | 0 | 31 | 0 | 31 | 0 | 0 |
| src/cli-do-1.cli.test.ts | 16.20 | 49 | 0 | 3 | 177 | 3 | 116 | 64 | 0 |
| src/cli-runs.cli.test.ts | 15.80 | 56 | 0 | 1 | 113 | 0 | 94 | 15 | 5 |
| src/monitor.cli.test.ts | 12.99 | 39 | 0 | 7 | 38 | 0 | 2 | 0 | 43 |
| src/worktree-3.cli.test.ts | 12.98 | 24 | 0 | 0 | 456 | 0 | 25 | 407 | 24 |
| src/landing-2.cli.test.ts | 12.33 | 11 | 0 | 10 | 146 | 0 | 5 | 139 | 12 |
| src/review-2.cli.test.ts | 12.32 | 31 | 0 | 14 | 462 | 0 | 11 | 423 | 42 |
| src/cli-projects.cli.test.ts | 11.16 | 55 | 0 | 6 | 144 | 0 | 105 | 41 | 4 |
| src/agents-sandbox-1.cli.test.ts | 10.76 | 24 | 0 | 9 | 542 | 0 | 13 | 498 | 40 |
| src/agents-sandbox-2.cli.test.ts | 9.72 | 9 | 0 | 9 | 239 | 0 | 0 | 222 | 26 |
| src/agents.cli.test.ts | 9.23 | 34 | 0 | 22 | 495 | 0 | 25 | 451 | 41 |
| src/worktree-1.cli.test.ts | 8.95 | 42 | 0 | 2 | 536 | 0 | 3 | 475 | 60 |
| src/worktree-5.cli.test.ts | 7.99 | 28 | 0 | 0 | 243 | 0 | 29 | 211 | 3 |
| src/run-2.cli.test.ts | 6.84 | 33 | 0 | 24 | 657 | 0 | 13 | 548 | 120 |
| src/docs.cli.test.ts | 6.26 | 49 | 0 | 3 | 112 | 0 | 36 | 65 | 14 |
| src/review-3.cli.test.ts | 6.17 | 8 | 0 | 11 | 445 | 0 | 6 | 419 | 31 |
| src/canon.cli.test.ts | 5.40 | 5 | 0 | 0 | 67 | 0 | 6 | 61 | 0 |
| src/git-environment-regression.cli.test.ts | 4.41 | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 3 |
| src/review-1.cli.test.ts | 3.32 | 26 | 0 | 1 | 238 | 0 | 10 | 227 | 2 |
| src/run-1.cli.test.ts | 2.81 | 74 | 0 | 6 | 211 | 0 | 52 | 148 | 17 |
| src/worktree-4.cli.test.ts | 2.52 | 19 | 0 | 8 | 214 | 0 | 0 | 208 | 14 |
| src/issue.cli.test.ts | 1.79 | 1 | 0 | 2 | 72 | 0 | 0 | 68 | 6 |
| src/linked-worktree-database.cli.test.ts | 1.34 | 5 | 0 | 0 | 15 | 0 | 9 | 6 | 0 |
| src/projects.cli.test.ts | 1.09 | 16 | 0 | 0 | 72 | 1 | 0 | 67 | 5 |
| src/workflows.cli.test.ts | 0.52 | 24 | 0 | 0 | 6 | 1 | 6 | 0 | 0 |
| src/route.cli.test.ts | 0.36 | 32 | 0 | 0 | 11 | 0 | 11 | 0 | 0 |
| src/catalog.cli.test.ts | 0.28 | 2 | 0 | 0 | 3 | 0 | 3 | 0 | 0 |
| src/evals.cli.test.ts | 0.17 | 2 | 0 | 0 | 13 | 0 | 0 | 6 | 7 |
| (process) | 0.00 | 0 | 0 | 13 | 229 | 1 | 0 | 215 | 27 |

### Top 20 tests

| test | file | wall s |
|---|---|---:|
| session-brief hook lists open resumes without injecting bodies > an inbox timeout reports unknown state, not zero questions | src/monitor.cli.test.ts | 10.031 |
| A lock waiter is served in arrival order | src/lifecycle-harness.cli.test.ts | 9.826 |
| landing is gated on the exact commit that reaches trunk > a successful gate with a leaked fifo writer still lands | src/landing-1.cli.test.ts | 6.173 |
| landing is gated on the exact commit that reaches trunk > a failed gate with a leaked fifo writer names its truncated capture | src/landing-1.cli.test.ts | 6.055 |
| landing is gated on the exact commit that reaches trunk > a failing test name printed after capture truncation is not claimed as captured | src/landing-1.cli.test.ts | 6.052 |
| the sandbox an agent is launched with > a killed preparation never publishes a partial hooks directory | src/agents-sandbox-2.cli.test.ts | 4.497 |
| behavioural canon evals > orch canon eval writes probe rows with canon_sha; skip honours last pass unless --force | src/canon.cli.test.ts | 4.241 |
| landing is gated on the exact commit that reaches trunk > landing binds confinement failures to the selected or current chain | src/landing-2.cli.test.ts | 4.131 |
| detached run collection > every --json surface has an enumerated and pinned output contract | src/cli-do-1.cli.test.ts | 3.641 |
| review-lens MCP provenance > continue without parent output inherits prefer, re-probes, and keeps MIRROR explicit | src/review-2.cli.test.ts | 2.894 |
| the sandbox an agent is launched with > every turn in a three-turn chain declares the inherited carry audit | src/agents-sandbox-1.cli.test.ts | 2.575 |
| a worktree is resolved against the main checkout, not the caller cwd > discard bounds an unresponsive Docker inventory and keeps the pointer | src/worktree-3.cli.test.ts | 2.465 |
| landing is gated on the exact commit that reaches trunk > a gate failure under the lock releases it for a waiting landing | src/landing-1.cli.test.ts | 2.407 |
| Landing holds its lock only for re-check, guard verification and fast-forward, never a gate | src/lifecycle-harness.cli.test.ts | 2.371 |
| detached run collection > continue --file accepts the same body when the reminder is short | src/cli-answer.cli.test.ts | 2.310 |
| detached run collection > continuing an unowned root adopts it before linking the child | src/cli-answer.cli.test.ts | 2.288 |
| detached run collection > continue --file reads the follow-up without shell interpolation | src/cli-answer.cli.test.ts | 2.265 |
| detached run collection > continue accepts a two-word follow-up beginning with -- | src/cli-answer.cli.test.ts | 2.235 |
| detached run collection > continue keeps flag-shaped words after the message starts | src/cli-answer.cli.test.ts | 2.228 |
| detached run collection > answer accepts six small --file rulings and resumes | src/cli-answer.cli.test.ts | 2.221 |

Step elapsed: 327.4 s on this machine (bun test v1.3.14).

Notes from this run:

- 31 `*.cli.test.ts` files, 831 tests, 0 fail. Process calls 8555. Database bootstraps 9 (1 suite-level in `(process)`, the rest in files that open extra stores).
- `(process)` is suite preload/fixture setup attributed before any test file is on the stack (1 bootstrap + fixture git).
- `cli` counts argv containing `cli.ts`; `git` counts argv0 basename `git`; everything else is `other`.
- landing-1: 920 Bun process calls (39 spawn + 881 spawnSync). lifecycle-harness: 958 (62 spawn + 896 spawnSync). Matches the spec lead of ~924 and ~959.

## 2. Ordering-dependency search

Every command in this section checked and propagated its own exit status. No
failure reproduced, so there is no failure text or test change to list yet.

### Every CLI file alone

Wall for the whole search was 82 s with at most four independent Bun processes.

| file | elapsed s | exit |
|---|---:|---:|
| src/agents-sandbox-1.cli.test.ts | 12 | 0 |
| src/agents-sandbox-2.cli.test.ts | 7 | 0 |
| src/agents.cli.test.ts | 17 | 0 |
| src/canon.cli.test.ts | 7 | 0 |
| src/catalog.cli.test.ts | 0 | 0 |
| src/cli-answer.cli.test.ts | 18 | 0 |
| src/cli-do-1.cli.test.ts | 17 | 0 |
| src/cli-projects.cli.test.ts | 12 | 0 |
| src/cli-runs.cli.test.ts | 18 | 0 |
| src/docs.cli.test.ts | 7 | 0 |
| src/evals.cli.test.ts | 1 | 0 |
| src/git-environment-regression.cli.test.ts | 5 | 0 |
| src/issue.cli.test.ts | 1 | 0 |
| src/landing-1.cli.test.ts | 62 | 0 |
| src/landing-2.cli.test.ts | 13 | 0 |
| src/lifecycle-harness.cli.test.ts | 24 | 0 |
| src/linked-worktree-database.cli.test.ts | 2 | 0 |
| src/monitor.cli.test.ts | 20 | 0 |
| src/projects.cli.test.ts | 2 | 0 |
| src/review-1.cli.test.ts | 3 | 0 |
| src/review-2.cli.test.ts | 14 | 0 |
| src/review-3.cli.test.ts | 7 | 0 |
| src/route.cli.test.ts | 1 | 0 |
| src/run-1.cli.test.ts | 9 | 0 |
| src/run-2.cli.test.ts | 10 | 0 |
| src/workflows.cli.test.ts | 1 | 0 |
| src/worktree-1.cli.test.ts | 11 | 0 |
| src/worktree-2.cli.test.ts | 16 | 0 |
| src/worktree-3.cli.test.ts | 14 | 0 |
| src/worktree-4.cli.test.ts | 3 | 0 |
| src/worktree-5.cli.test.ts | 10 | 0 |

The route/scoring unit files also passed alone: `src/route.test.ts` (1 s),
`src/review.test.ts` (<1 s), and `src/review-tier.test.ts` (<1 s).

### Four measured-time shards alone

The shard processes ran concurrently; wall was 97 s. File membership is shown
in the shard table below in its eventual gate order.

| shard | measured file total s | observed elapsed s | tests | exit |
|---:|---:|---:|---:|---:|
| 1 | 76.57 | 96 | 163 | 0 |
| 2 | 76.24 | 97 | 191 | 0 |
| 3 | 76.54 | 77 | 182 | 0 |
| 4 | 76.07 | 91 | 297 | 0 |

### Repeated and randomized routing search

Because neither the files nor the four shards failed, the two routing files
were repeated under enforced exit checking: `src/route.test.ts` passed 100/100
runs (85 s wall) and `src/route.cli.test.ts` passed 100/100 runs (151 s wall).
The route/scoring set (`route.test.ts`, `route.cli.test.ts`, `review.test.ts`,
and `review-tier.test.ts`) then passed 100/100 runs with Bun test randomization
and explicit seeds 1 through 100 (220 s wall). No test was changed.
