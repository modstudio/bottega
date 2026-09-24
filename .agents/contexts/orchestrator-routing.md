---
description: Why delegation exists, scoring, routing, fidelity, failures, capabilities, and local-model serving.
paths:
  - orchestrator/src/**/route*.ts
  - orchestrator/src/**/routing*.ts
  - orchestrator/src/**/score.ts
  - orchestrator/src/**/judgment.ts
  - orchestrator/src/**/evidence*.ts
  - orchestrator/src/**/agents.ts
  - orchestrator/src/**/agent-*.ts
  - orchestrator/src/**/capabilities.ts
  - orchestrator/src/**/model-host.ts
  - orchestrator/src/**/failover.ts
  - orchestrator/src/**/failure*.ts
  - orchestrator/src/**/recalibration.ts
  - orchestrator/src/**/guide.ts
  - orchestrator/src/**/doctor.ts
  - orchestrator/src/**/duel.ts
  - orchestrator/src/**/outcome.ts
  - orchestrator/src/**/jobs.ts
  - orchestrator/src/**/pack-budget.ts
  - orchestrator/src/**/standard-*.ts
---

# What it is for

Claude's allotment is the scarce resource. A Claude subagent bills that same allotment; an external agent does not. Work that would spawn a Claude subagent spawns `codex`, `grok`, `agy`, or a local model — and Claude keeps design, judgment, and synthesis.

# Implementation is delegated because escalation makes it safe

A delegated implementation goes wrong as a **guess**: an agent hits an ambiguity, resolves it silently, and builds on its own answer. A worker that must stop and ask turns that into an explicit decision at the one place holding the whole design. The safe shape is **one agent building one bounded spec, escalating every design decision to the architect**.

The architect owns design, the spec, every decision the spec did not settle, and judging the diff. The agent types. `fidelity` is scored so the diff is reviewed against the spec rather than the agent's summary.

# Scoring is not optional

`orch score` is the only thing that measures whether delegation works.

- Every run records the session from `CLAUDE_CODE_SESSION_ID`. Only that session can judge it. `orch score` **refuses** another session's run. `CLAUDE_CODE_BRIDGE_SESSION_ID` is shared and is never an identity: `sessionId()` returns the primary id or nothing, and a mutation that needs an owner refuses rather than proceeding under the shared id.
- `orch pending` lists your own unscored runs and exits nonzero while any remain.
- A Stop hook raises them before a session finishes, once per turn, and stands down if it has already asked.
- `orch answer` and `orch continue` refuse escaped and confinement-unverified chains, naming `orch confinement clear`. Unread `orch tell` messages surface at the harness checkpoint before the final parse. Every write verb prints usage on `--help` with no side effects.

**Never score a run you did not read.** A guessed verdict teaches the router something false. Nobody may score another session's runs. The refusal names the owning session.

# The two halves of the ratio

Every command here drives the numerator down. **`orch score` is the only thing that measures the denominator.** A run nobody scored and a run scored badly must stay distinguishable. Delegation that is never scored is delegation you cannot tell is working.

# Routing

A job declares the capabilities it needs; an agent that lacks one is excluded rather than ranked. History decides only once a job has `MIN_SAMPLE` judgments; below that the declared preference wins.

Pairwise judgments are collected at score time. `orch stats` reports Bradley-Terry strengths once a job has enough duels. Routing still does not use them. An off-policy backtest cannot decide a routing change, because disagreements have no counterfactual outcome; the standing challenger draw is the online experiment that can.

**A run that produced nothing counts as delivery `none`.** Failed and abandoned runs fold into the mean at that `WEIGHT`, so a failure is evidence. The threshold counts **judgments**, not verdicts.

**Exploration goes to agents that might win, not to ones already known not to work here.**

**Quality decides alone whenever the gap is real; a tie is broken by facts.** A gap smaller than `NOISE_BAND` is noise. Inside that band the tie goes first to an agent that spends no metered quota, then to the faster one by median run time.

**Proven scores are shrunk toward the field before they are ranked:** `(points + MIN_SAMPLE * prior) / (evidence + MIN_SAMPLE)`, prior being the mean raw score of every proven agent on that job. Reports keep the raw mean beside the shrunk score.

**Thompson sampling is the live ranker.** A real dispatch draws from the posterior; status surfaces use the posterior mean, so `orch pick` does not spend a draw. The standing-challenger floor decays from `STANDING_EXPLORE_RATE` with the proven leader's judgment count, bottoming at `STANDING_EXPLORE_FLOOR`. A model swapped behind an agent name starts a fresh posterior and does not inherit the old mean.

For findings jobs, reviewer precision breaks a tie inside the noise band when the named lens has enough triage evidence. A measured precision outranks an unknown cell; an unknown is not zero. Precision never reaches across a real quality gap. Findings jobs route on the named lens once at least two eligible agents each have `MIN_SAMPLE` judgments in that lens cell (one eligible agent's `MIN_SAMPLE` suffices). Until then they use the job-wide cell. A lens cell never combines with a stack cell; unrecorded runs remain job-wide evidence.

A failing behavioral canon eval closes exploration for the default eval agent until that eval passes. It does not erase proven routing evidence and it does not override `--agent`. Harness failures are not wrong answers and do not close exploration.

# A judgment has two axes

**DELIVERY:** `none` | `partial` | `full`. **QUALITY:** `wrong` | `mixed` | `right` — not asked when nothing arrived, and the schema refuses the combination. Delivery failure is plumbing; quality failure is judgment. The matrix is `WEIGHT` in `score.ts`.

**A run is one judgment, not two.** A failure counts as `none` only if nobody judged it explicitly.

**No answer is negative, a wrong answer is zero.** Nothing arriving should push routing away; a wrong answer stays a weaker candidate. Failed and abandoned runs score at the `none` weight.

**Three levels an axis, deliberately.** Named levels score the same twice. `orch stats` reports the corpus. Ties break on cost and latency.

## Measuring the scorer

`orch recalibrate` blindly re-scores old outputs and reports quadratic-weighted kappa per axis without changing the original score.

**The vocabulary lives in `score.ts` and every prompt is generated from it.** A level that is not offered does not exist. Evidence identity is the caller prompt (`spec_sha`), the change (`patch_id` and path set), the lens, and the effective model.

**Calibration runs are marked `--probe` and never count as evidence.** `orch pending` and the Stop hook skip them. A probe is excluded from every query that routes or reports.

**A share of runs goes to challengers.** Unproven agents that might win receive the exploration draw; once proven, `STANDING_EXPLORE_RATE` keeps testing against the leader.

**Prompt size is an eligibility question.** Grok and agy take the prompt on argv (`ARGV_PROMPT_BYTES`); Codex reads stdin. A pack too large for an argv agent excludes it. Every compiled project and job canon pack must fit `DEFAULT_PACK_BYTES`.

**So is context.** A job declares its working set; an agent whose window cannot hold that is excluded, the same kind of fact as lacking `readsRepo`. Errand jobs sit at `ERRAND` tokens, deep jobs at `DEEP`. Eligibility requires `OUTPUT_RESERVE` on top, because a server allows window minus prompt for the reply. The declared window is the one the server reports; `orch doctor` reads it from `/v1/models`. Cloud agents declare no ceiling until one fails on window.

**Metered billing is a hard exclusion.**

Retrieval-shaped jobs (`file-question`, `canon-lookup`, `summarize`) prefer the local model. Judgment-shaped jobs (`safety`, `craft`, `understand`, `review-lens`) prefer cloud agents. Preference orders agents that could do a job; eligibility says which ones can.

# A third axis: did it build what it was asked to build?

**FIDELITY:** `drifted` | `partial` | `faithful`, judged on writing jobs only. Delivery and quality cannot see a complete, correct change that solves a **different problem**. Fidelity is a penalty (`FIDELITY_PENALTY` in `score.ts`), not a third matrix dimension.

**Asking is faithful and costs nothing.** That has to hold in the arithmetic or asking stops.

**The value of an escalation is the interruption, not the correctness of the question.** Never mark an escalation down for being wrong, on fidelity or on quality. An architect who overrules one should say what made the concern reasonable.

**Required on a writing job that delivered something.** `delivery: none` takes no fidelity. Files changed, tests claimed, deviations and questions are recorded automatically beside the verdict, because the signal is where they disagree.

# One score, reported the same everywhere

There is one `scoreboard()` and the views call it. A test asserts every cell matches `candidates()` for its job. Two pages must never both compute a score.

# Activity counters and score windows

The routing matrix and guide do not take a dashboard activity window. Their bound is `EVIDENCE_WINDOW`, the most recent judgments for a job, agent, and the agent's current model. A model swap starts a fresh posterior. Per-repo tallies report activity, not routing evidence, and take neither window. Empty-window sums are coalesced, because SQLite `SUM` over no rows is null while `COUNT` is zero.

# When an agent runs out of plan

No CLI here reports remaining quota, so exhaustion is caught on the failure (`FAILURE_KINDS`). Truncation is not evidence the agent was wrong. `NEEDS_HUMAN` kinds notify immediately.

**Escaped** means an outside change overlapped the run's own diff: classified and attributed, never failed over, and landing that chain is refused even when marked unreviewed. Non-overlapping divergence is recorded and does not fail the run. **Confinement unverified** has the same terminal and landing-blocking effect, but records an observer failure. A checkout unavailable before launch is excluded with a warning that names the stale register entry. The detector never drops findings, scores, or the review.

**Routing then avoids a `COOLS_DOWN` agent for `COOLDOWN_MIN` minutes**, unless it is the only one left. Only the most recent run is consulted; a single success clears it. **A probe is how you say "I fixed it"** — the cooling query is the one place probes are not filtered out. `orch doctor` prints this when anything is cooling.

A vendor **content refusal** fails over immediately, but neither cools the agent nor counts as routing evidence. Keep it distinct from a headless `denied`.

# Infrastructure and policy failures are not verdicts

**`unreachable` is not evidence about the agent** and is excluded from the evidence count entirely, not weighted down. Host incidents: `orch doc show local-model-host-incidents --scope machine`. `NOT_EVIDENCE` lists the kinds that say nothing about competence.

**`unreachable` tells a person but does not cool the agent down.** A cooldown is for a condition that cannot be observed without spending a run (`COOLS_DOWN`). Reachability is measured directly before every routing decision. `NEEDS_HUMAN`, `COOLS_DOWN` and `NOT_EVIDENCE` are three separate lists.

**Reachability is a routing input, not a run outcome.** `orch do` probes the local endpoint before it routes. The probe is cached per process; longer-lived processes refresh it. **`orch doctor` is where you look** — box, tunnel, server, in that order.

**An agent's window must hold the working set and a reply.** Eligibility requires `OUTPUT_RESERVE` on top of the job's `contextTokens`.

# Knowing what to use for what

`orch guide` names two agents per job: quality and turnaround. A leader below `MIN_SAMPLE` is **provisional**, not recommended. It lists eligible agents nobody has tried. Latency is shown beside median prompt size. The guide is deterministic and does not spend the exploration draw.

# Agent capabilities are not interchangeable

An agent is a row: harness, backend, and model. None of those is a capability declaration.

**Capabilities come from `orch agent probe`, never from inference or a model card.** An unprobed row is ineligible for repository work; a row with no declared or probed window is ineligible for every job with a working set.

- `readsRepo` — can find and open files unaided. **`agy` cannot.** Its row is disabled and retained as the referent for that history. Inline work routes to the cheapest enabled inline-capable row. **A diff is already a self-contained pack.** Packs that name sources instead of carrying them fail on an agent that cannot prompt for a read. Detail: `orch doc list --scope job`.
- `mcp` — can call the MCP servers **that client has registered**, not this machine's. `--mcp` means this agent can use the servers it has. Grok does not start a repo-local server until the folder is trusted; for an orch-created worktree, `--mcp` passes scoped `--trust`. A healthy unrelated server such as `orch-ask` does not count. Detail: `orch doc list --scope agent`.
- `schema` — can be bound to a JSON schema for the final message. Grok's `--json-schema` constrains the model; Codex's `--output-schema` is silently dropped when MCP tools are active. Prefer Grok when the contract must hold.

**Grok takes its prompt on argv** (`ARGV_PROMPT_BYTES`). Codex reads stdin.

# Local model

`local-acp` drives the OpenAI-compatible endpoint through Goose ACP. Register with `orch agent add`, then probe. `orch doctor` prints the command when `ORCH_MODEL_HOST_URL` and `ORCH_MODEL_HOST_MODEL` are set and no enabled ACP row points at that endpoint. Another local model is another row, not another driver. `qwen-local` remains only as a disabled referent so its recorded runs keep their meaning.

`available()` is configuration; `orch doctor` is reachability. The registration probe is the authority on file tools and structured output; `/v1/models` is the authority on the served window (`LOCAL_CONTEXT_TOKENS`). `local-acp` must be served with a window of at least a deep job's `contextTokens` plus `OUTPUT_RESERVE`.

The window is a serving flag. Check concurrency at the endpoint, not the model card. A starved verdict measures the serving parameter, not the agent.

**The endpoint must serve `/v1/responses`**, not merely `/v1/chat/completions`. vLLM serves it; llama.cpp bridges it; Ollama does not.

**Run Codex where it can see the repository, against a tunneled endpoint.** Bind the server to localhost on the model host and forward it. Never bind it to `0.0.0.0` on a routable interface. Do not use `--oss` / `--local-provider`. Do not name the provider `oss`.

Host facts: `orch doc show local-model-host-incidents --scope machine`.
