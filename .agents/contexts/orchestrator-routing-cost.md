---
description: Cost policy, metered routing, provider failures, cooldowns, and billing holds.
paths:
  - orchestrator/src/**/route-cost*.ts
  - orchestrator/src/**/route-metered*.ts
  - orchestrator/src/**/billing-key-hold*.ts
  - orchestrator/src/**/routing-cooldown*.ts
  - orchestrator/src/failure/*.ts
  - orchestrator/src/run/run-close.ts
  - orchestrator/src/run/run-subscription-cost.ts
---

# Cost policy

**A metered agent is routed only when its row opts in, and only for jobs that do not write the repository.** Spend limits live in the provider key's own settings.

Where a rule in `DEFAULT_ROUTE_COST_POLICY` (overridable through `routing.cost_policy`) is on, an agent below the rule's floor is excluded, and a pricier agent wins only when its quality gain at the rule's rate is worth its cost per accepted result. `bottega agent cost-backtest` measures a rule change before it ships.

A subscription agent whose transport records quota readings is paced on every job that does not write the repository; writing work always has priority. High-stakes lenses use the high-stakes mapping in `DEFAULT_ROUTE_COST_POLICY` and may consume up to the elapsed window pace, while other paced work keeps `PACE_HEADROOM_PERCENT` unused. A current reading supplies the estimate and a qualifying window under `QUOTA_MIN_WINDOW_PERCENT` supplies its token calibration; with neither, paced work is refused.

# When an agent runs out of plan

No CLI here reports remaining quota, so exhaustion is caught on the failure (`FAILURE_KINDS`). Truncation is not evidence the agent was wrong. `NEEDS_HUMAN` kinds notify immediately.

**Escaped** means an outside change overlapped the run's own diff: classified and attributed, never failed over, and landing that chain is refused even when marked unreviewed. Non-overlapping divergence is recorded and does not fail the run. **Confinement unverified** has the same terminal and landing-blocking effect, but records an observer failure. A checkout unavailable before launch is excluded with a warning that names the stale register entry. The detector never drops findings, scores, or the review.

**Routing then avoids a `COOLS_DOWN` agent for `COOLDOWN_MIN` minutes**, unless it is the only one left. Only the most recent run is consulted; a single success clears it. **A probe is how you say "I fixed it"** — the cooling query is the one place probes are not filtered out. `bottega machine doctor` prints this when anything is cooling.

A job may declare an idle limit; a run silent and idle past it is killed, fails over, and is not evidence.

A goose run that starts more than `TOOL_CALL_BURST_LIMIT` tool calls within `TOOL_CALL_BURST_WINDOW_MS` is killed as `tool_burst`, which cools the agent and counts as evidence. Other harnesses record the burst without killing. Every tripped burst, killed or not, is shown in `bottega agent stats` (`orchestrator/src/run/tool-call-burst.ts:toolCallBurstAction`). Session replay before the prompt is never counted (`orchestrator/src/transport/transport-acp.ts:liveAcpEvent`).

**An uninterrupted streak of `PROVIDER_ERROR_STREAK` provider errors cools the agent the same way**, and a successful probe ends the streak. **A billing failure on an agent-paid key holds every agent on that key** (`orchestrator/src/route/billing-key-hold.ts:decideBillingKeyHolds`) in routing and in failover, until a successful answer on any of them clears it. Recency is completion order, never launch order: a long run that finishes last is the latest.

A vendor **content refusal** fails over immediately, but neither cools the agent nor counts as routing evidence. Keep it distinct from a headless `denied`.

# Infrastructure and policy failures are not verdicts

**`unreachable` is not evidence about the agent** and is excluded from the evidence count entirely, not weighted down. Host incidents: `bottega doc show local-model-host-incidents --scope machine`. `NOT_EVIDENCE` lists the kinds that say nothing about competence.

**`unreachable` tells a person but does not cool the agent down.** A cooldown is for a condition that cannot be observed without spending a run (`COOLS_DOWN`). Reachability is measured directly before every routing decision. `NEEDS_HUMAN`, `COOLS_DOWN` and `NOT_EVIDENCE` are three separate lists.

**Reachability is a routing input, not a run outcome.** `bottega run start` probes the local endpoint before it routes. The probe is cached per process; longer-lived processes refresh it. **`bottega machine doctor` is where you look** — box, tunnel, server, in that order.

**An agent's window must hold the working set and a reply.** Eligibility requires `OUTPUT_RESERVE` on top of the job's `contextTokens`.
