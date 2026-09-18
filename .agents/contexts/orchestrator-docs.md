---
description: Docs, canon store, resume briefs, the project register, the subagent gate, and published scores.
paths:
  - orchestrator/src/**/docs.ts
  - orchestrator/src/**/doc-commands.ts
  - orchestrator/src/**/canon*.ts
  - orchestrator/src/**/projects.ts
  - orchestrator/src/**/project-commands.ts
  - orchestrator/src/**/serve.ts
  - orchestrator/src/**/metric*.ts
  - orchestrator/hooks/block-agent.py
  - orchestrator/hooks/session-brief.py
---

# Docs

Operator docs are markdown facts about an installation, stored in `orch.db` rather than baked into code. Scopes are `DOC_SCOPES` in `shared/docs.ts`: `global` applies everywhere; `project`, `agent`, and `job` each name a registered subject; `stack` names a register stack, and its documents serve every project on that stack; `resume` names a project as its subject (the epic is the slug); `machine` and `global` have no subject.

**Canon rows are scope `canon` and hydrate into the tree.** Canon is stored in `orch.db`, edited through orch under write-time gates, and hydrated by script into each project's committed files. Estate facts stay in the doc store and are never hydrated. Worker prompts receive canon through the pack (global always-on rows, then the project's, then a context index) and job documents whose delivery is `inject`. `setDoc` refuses `inject` for project and global documents: an instruction is canon, and anything else is fetched on demand. Agent, machine and resume documents never enter a worker prompt.

**Shared workflows follow the same store-first cycle.** The production step catalogue and workflows live in `orch.db`; `orch workflow hydrate` writes them into a worktree's `.agents/workflows` and `.agents/workflow-steps` folders, and the commit carries what it wrote. `orch workflow import` turns edited tree files back into drafts and never promotes; promotion stays an explicit `orch workflow` verb, catalogue before the workflows that use its new steps. Those folders are the review surface only: a harness reaches a workflow as a prompt served by `orch mcp`, so no project, this one included, carries workflow command files in its tree.

**Agent content lives under `.agents`; `.claude` only mirrors it.** Rules and skills are real folders under `.agents`, and the same-named entries under `.claude` are symlinks to them. `.claude` otherwise holds harness state that is not content. `scripts/check-harness-mirror.ts` enforces this.

`orch doc` manages individual docs; `export`/`import` round-trip the scoped directory layout, and `resumes` lists open resume briefs for the project containing `--cwd`. On a first run, the canon pack and the job's inject documents are inserted after worktree infrastructure and before the supplied spec, so their bytes participate in routing. Resume turns do not repeat them. Agent docs describe vendors as observed here and belong to the router and architect; machine docs describe the host. Resume briefs belong to the architect session.

`orch mcp` serves project and doc tools over stdio; `orch mcp --config` prints the registration object without changing it.

`hooks/session-brief.py` fails open: it asks `orch doc resumes` for the cwd and claims monitor conditions addressed to the starting session. When the resume list is non-empty it appends the list and one sentence — ask before loading on `startup`/`resume`, offer to resume on `clear`/`compact`/`fork`. It never fetches a brief body and never resumes anything itself. Addressed monitor conditions use at-least-once delivery: a hook reads without consuming, emits, and only then acknowledges, so interruption may repeat a notice but cannot lose one. Unowned findings remain in the monitor report. During a session `hooks/orch-heartbeat.sh` reads and acknowledges the same addressed stream. These two hooks are the delivery paths: the machine-wide monitor does not push into a harness channel. On any error, timeout, or missing binary the SessionStart hook exits `0`.

# Resume briefs

A long architect session loses its thread at a `/clear` or a compaction, so "where we are and what is next" lives outside the conversation, in the doc store, and is re-offered when a new session starts.

A resume brief is a doc at `scope = resume`, `subject = <project>`, `slug = <epic>`. Status lives in the body's frontmatter, not in the address — a consumed brief keeps the same name so it stays readable. Frontmatter keys: `status` (`open` | `consumed`), `epic`, `project`, `written` (ISO `8601`), `consumed` (ISO `8601`, absent while open).

**Writing.** At a task or epic boundary, draft the brief **in the conversation as markdown**, and write it only after the operator approves. Never draft-then-store-then-show; the approval must precede the write. Writes go through `set_doc`.

**Brief contents.** Epic and task just finished; decisions made and the reasoning that produced them; open `orch` job ids and what each was asked to build; files and paths touched; and an explicit `NEXT ACTION` line.

**Resuming.** The SessionStart hook lists open briefs; it does not inject a body. The agent reads the list, asks which (or offers the single one), fetches it with `get_doc`, then marks it consumed with `set_doc` — flipping `status` and stamping `consumed`. Declining must not consume anything.

# Projects are rows, not literals

Resolution is by **containment**: a worktree under a registered checkout resolves to its project with no special case, and the longest path wins so nesting resolves inward. Anywhere unregistered is `null` rather than a guess.

**One guess survives, deliberately.** The metric still recovers a numbered clone from the path, because another machine checks out repositories that are the same repo under a different directory name and will never be registered here. It is a fallback for paths the register does not answer, not a second source of truth.

The register seeds itself once from the run history. That is **data, not code**. A fresh checkout elsewhere has no history, seeds nothing, and starts with `orch project add`.

**The stack is why this is not merely tidying.** Agents are not uniformly good, and a router keyed only on job type averages strength on one stack and weakness on another into a number true of neither. Stack rather than project so two apps on the same stack pool their evidence.

**Narrowing needs two proven agents on that stack.** One is not a comparison; it is a smaller evidence base for a decision that would have been made anyway, and it is actively worse — an agent with many job-wide judgements and few here is demoted to unproven and loses to whichever reached `MIN_SAMPLE` on this stack first. Below the bar, job-wide evidence answers exactly as before, and `orch pick` says which it used.

# Project facts are declared, not inferred

orch is project-agnostic. Every fact that differs by project belongs in that project's register row, declared in a shape the dispatcher can read and act on — not in orch's code, not in checked-in markdown, and not buried inside a string that something later greps.

**An inferred capability fails at the moment of use; a declared one fails at registration.** Registration checks the declared landing branch against `HEAD` and any canon integration-branch rule; pull requests target the landing branch, never a configured production branch.

The reverse mistake is still the same defect. A fact that does not vary by project must not be copied into project settings. Tracker tool names follow from the tracker protocol the register already records, so they belong to the shared protocol adapter rather than to every project using it.

The test is whether the fact varies **by project**; if it does not, it does not belong in a project row however project-shaped it looks. If the dispatcher must act on it — decide that something is possible, refuse early, or describe a capability honestly — it must be readable rather than deduced. Its shape is the smallest one that answers what the dispatcher actually asks.

# The subagent gate

A `PreToolUse` hook (`hooks/block-agent.py`) denies Claude-subagent spawns for work an external agent could do. **Web work is allowed, but it declares itself** — `NEEDS-WEB` in the opening of the prompt or description. Only that opening is checked so a quoted repository excerpt deep in a prompt does not become a declaration.

**A URL is not a declaration.** A prompt can quote a docs link or stack trace without anyone deciding it needs the network. A URL is noted in the log and nothing more.

**Denial happens on `PreToolUse` only.** `SubagentStart` carries no prompt to judge and its schema rejects a permission decision outright. It is audit-only. Everything the gate does not deny is recorded too, including `Workflow`.

The declaration is not a lock. Anyone can write `NEEDS-WEB`, and preventing that is not the point: writing it is deliberate and recorded, so a habit of declaring web work that is not web work shows up in `orch spawns`. There is no rewording path — one deliberate act is auditable, three rewordings are not.

**A denial has to name a route that exists.** The refusal names the path, rather than forbidding the only available one.

**Every spawn is logged, allowed and denied alike.** A gate that cannot report what it let through cannot be tuned.

For this Claude adapter, the architect's web-capable path for the required pre-spec research is a Claude subagent whose prompt begins `NEEDS-WEB`. The root canon states the harness-neutral requirement and puts the resulting ruling in the spec; this is the adapter-specific mechanism that performs it here.

# The dashboard lives in hub and is loopback-only

This concern routes and scores. It does not draw a page.

`hub serve` shows routing, agent health, the score matrix and the run list beside the work the runs were spent on. What hub reads is published deliberately, never by opening `orch.db`. There is one `scoreboard()`, and hub renders what it returns rather than deriving its own. **Two pages must never both compute a score.**

**`--scorer` is the session gate's one named exception.** The gate exists so an agent cannot judge a run it never read; a person clicking a verdict has the output on screen. Recording who judged it makes it auditable: dashboard verdicts land as `scored_by = hub-dashboard`.

Hub binds loopback (`127.0.0.1`) because the payload hands out the full text of every prompt and every reply and accepts an unauthenticated POST that writes scores. On a shared network that is both a reader of the repos and a writer of the one table here that is supposed to be evidence.

# Four lenses, and reading the trend

The ratio is reported against four denominators (`LENSES` in `metric.ts`), because each is wrong in its own direction and agreement between them is the only real signal: per task (blind to work carrying no ticket), per product line (rewards volume), per commit (commit habit rather than effort), per file touched (depth of change).

**Files are categorised, not filtered.** Generated output has to come out whatever else happens. Tests are their own category rather than deleted. Docs and config are separated for the same reason: the mix is itself information.

**Spend is split canon vs untracked.** Work outside the registered repos ships no task key, so counting it against a canon denominator inflates the ratio against work it never touched. It is reported on its own instead of divided by something it did not contribute to.

The repo a message belongs to comes from its own cwd, with a numbered-clone suffix stripped.

The ratio's direction compares the **halves of the window**, not consecutive days. Each half is totalled and divided once rather than averaged over daily ratios. The calendar midpoint of the window divides the halves; excluded days do not move that boundary. Two kinds of day cannot be read as a ratio: today (spend accrues in real time while commits land later), and a day with tasks but almost no tokens (a gap, not efficiency; the threshold scales to the window's own median). Both are still drawn so the chart never hides what it did not use. Lower is better. Inside the noise these bursts generate, a small change is reported as flat; with few tasks in either half it says unknown.

The chart itself — panels, hover, stacking — belongs to hub.
