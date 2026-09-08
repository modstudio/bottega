# Bottega

A workshop. One designer holds the whole picture, several hands build to that
design, and nothing ships the designer has not read and signed.

The name is Verrocchio's: assistants executed to the master's drawing and the
master put their name to the result. It is not decoration — it is the division
this codebase enforces. `orchestrator/` delegates implementation to external
agents under a contract that forbids them to decide anything; a worker that
reaches a judgement call stops and asks, and the architect rules, reads the
diff, and judges it on whether it built what it was asked to build.

It was called `devbox`, which described a scratch directory for one machine's
odds and ends. That is what it was.

Several concerns live here side by side because they share a machine, not
because they share a purpose. **The name is written once, in
`shared/brand.ts`**, and `check-brand` fails the build if it appears anywhere
else in code — a brand module nobody is obliged to use collects leaked literals
until the rename it existed to make cheap is a hunt through twenty files.

## The concerns, and the line between them

| | what it is |
|---|---|
| `orchestrator/` | Delegate work to external agents, score them per job type, and route the next job by what scored well. Has its own canon. |
| `ops/` | The machine itself: the morning refresh, launchd agents, brew upkeep. |
| `hub/` | Every project's work in one view: what is in flight, what each task cost, and the daily report. Has its own canon. |
| `local-stack/` | Serving models locally, and the local model host. |
| `shared/` | The only code any two concerns may both import. |

Cross-project porting used to be its own concern at `port/`. The directory
is gone. The ledger, pairs, baselines, skips and doctrine now live in
`orch.db` and are reached through `orch port` and the MCP tools.

**They do not reach into each other.** A concern imports from itself or from
`shared/`, and `shared/` imports from nobody. `bun run check` enforces it,
because a boundary nobody checks has already drifted — the same reason a sibling project
holds its kernel/context floor with a script rather than a rule.

Three more separations that matter as much as the import graph:

- **A database per concern.** `orchestrator/orch.db` is its own. A shared
  database is how two concerns quietly become one.
- **A binary per concern**, in `bin/`. `orch` does one thing.
- **Canon per concern.** Each directory carries its own `AGENTS.md`; a session
  working in `ops/` is not handed the orchestrator's rules.

## What bottega is for the other projects

Bottega is the AI orchestration infrastructure for every project on this
machine: agent management and the whole lifecycle — dispatch, review, scoring,
routing, landing, tasks, docs, workflows, canon and the machine itself.
Anything workflow-related is resolved HERE, once, and offered to projects; it
is not offloaded to them.

This week's evidence is four projects each carrying a port of the same
review-tier ladder, three doctrine rewrites in an hour, and a register note and
a project canon disagreeing on a test count. Every per-project copy of
orchestration drifts, and the drift is the cost.

A project that already has its own system for a concern keeps it, and bottega
honours it: its own task tracker, doc store, workflows or review pipeline. The
project register (`orch project list --json`) is where a project declares which
concerns it keeps; everything it does not declare, it takes from bottega whole.
That declaration is prose in the register today and becomes a structured field
when the first project actually declares one, not before: observe first.

The long-term shape is that a project needs no orchestration of its own. A
per-project port of bottega machinery is a transitional state to retire, not a
pattern to extend. Worktree scripts are the exception: they are how a project
builds its own trees, and the register's create recipe is the interface. Canon
or workflows in a project that duplicate bottega's are candidates for removal
once that project declares it uses bottega's.

A session reads the register entry before assuming which system applies. Build
new orchestration, review or lifecycle capability in bottega and expose it
through `orch`, the MCP surface and the register. Never copy a bottega mechanism
into a project as a script when the project could call bottega.

## Secrets

**No concern here stores a secret.** MCP tokens live in `~/.claude/.env`, the
SMTP password in the login keychain, and `hub`'s settings hold a *reference*
(`keychain:work-report-smtp`) which the dashboard reports only as resolving or
not. Read them at use time; never at import, never into a log, never into a
database the dashboard serves from.

The metered Anthropic key that used to sit in `work-report/config.json` is gone
with it. Summaries go through `orch`, which spends neither metered billing nor
the Claude allotment — the one cost the orchestrator exists to avoid.

So is the directory. `1b07f45` retired the concern but left 224K of Python, its
logs and a still-tracked `config.json` on disk — a seventh concern that the table
above does not list and `bun run check` does not police, which is how a retired
thing goes on quietly being part of the repo. Its 22 files are recoverable from
`1b07f45^` if they are ever wanted.

## This machine

**One checkout per project.** Numbered clones are gone. Parallel work happens in
git worktrees under each repo's `.claude/worktrees` — one project routinely
carries a dozen or more.

**Nothing here refreshes a worktree.** A worktree belongs to one task and one
session; a scheduled job mutating them behind the author's back would destroy
more than it fixed. `ops/` refreshes main checkouts only.

**After cloning:** `git config core.hooksPath .githooks`. The commit-msg hook there refuses AI attribution in commit messages; the matching Claude Code hook lives in `orchestrator/hooks/no-attribution.py`.

**There is a remote, and landing does not use it.** `origin` is
`modstudio/bottega`, private. For most of this repository's life there was none,
and that was invisible until a day of landings went wrong on the only copy of the
work that existed — a killed landing, a stripped ref guard, a staged revert and a
stale ref lock, each operating on state nothing else held. Nothing was lost; the
recovery from any of them going differently would have had nothing to recover
from.

So the remote is an OFF-MACHINE COPY, not a step in any workflow. `orch land`
still merges fast-forward into local trunk and **never pushes**, and that is
unchanged — pushing is a separate, deliberate act. A branch that has landed is
safe from a bad reset only once someone has pushed it, and nothing does that for
you.

## Tasks

Work here is tracked in `hub`, and every task carries a `DEV-` key:
`./bin/hub task list --project bottega`, `hub task new --project bottega --title "..."`.
Branches and commit subjects cite the key, and `orch do` requires `--key`; work naming
no key is recorded against the project with no task and the link cannot be recovered.

**The project register is the authority** on key prefixes, worktree recipes,
per-project notes and on which concerns a project keeps for itself (see above) —
`orch project list --json`. Read it before concluding a project lacks something.

## What this is for

Bottega is orchestration that lives BELOW the primary frontier harness. It does
not replace one. The harness above — where the architect designs, rules and
judges — is swappable, and Claude Code is one adapter among possible others. A
design that assumes a particular harness is wrong here.

Two purposes, and they are one thing:

**Delegation that costs nothing in judgement.** The architect brings a frontier
model for what it is worth — design, rulings, synthesis — and the building goes
to agents on flat-rate subscriptions and to local models. The scarce resource is
the architect's attention and allotment, never money, which is why every surface
here returns DECISIONS rather than data for the architect to reason over.

**A lifecycle built for agents rather than retrofitted onto tools built for
people.** Contracts, escalation, scored fidelity, review lenses, canon compiled
into every prompt.

Neither half is worth much alone. The delegation is only safe because the
lifecycle machinery is what stops cheap tokens producing expensive rework.

## Why delegating costs you nothing

The obvious objection to sending work to a cheaper model is that you get cheaper
work. It does not hold, and the reason is worth stating precisely.

Any change has two parts: the decisions, and the typing. Most of what makes a
change good is decided before a line is written — what the thing should do, which
ambiguity resolves which way, what must not break. A worker forbidden to decide
contributes none of that. It contributes the typing. The judgement in the diff is
the architect's, arriving through a different pair of hands.

So the question is never whether this model is as good as the frontier one. It is
whether any decision leaked into the worker. Where none did, you lose nothing by
delegating, because there was nothing of the worker's judgement in the result to
lose.

That is a claim about mechanism, not goodwill, and three things make it true
rather than hopeful:

- **The contract forbids it.** A worker reaching a judgement call stops and asks.
  It does not resolve the ambiguity and build on its own answer.
- **Asking is cheap enough to happen.** A durable escalation costs a turn and a
  resume, which is enough friction that a worker facing three small ambiguities
  batches them or quietly decides two. The live ask channel removes that: the
  worker blocks mid-task, the ruling arrives, the turn survives. One working day
  produced nine escalations, every one a real fork, and no silent guesses.
- **Deviation is measured, not trusted.** Fidelity is a scored axis for exactly
  this failure: an agent can return a complete, correct, tested change that
  solves a DIFFERENT problem, and delivery and quality both read it as flawless.

Asking is faithful and costs nothing. That must hold in the arithmetic or it does
not hold at all — a worker penalised for asking learns to guess, and the argument
collapses.

## Why judge and route

If workers supply typing rather than judgement, the remaining question is which
one gets a given job. Not the best benchmark, the best marketing, or somebody's
default — those describe a model in the abstract, and the work is never abstract.

The evidence that decides is your own: runs on your repositories, scored on what
you accepted and what you sent back, keyed to the shape of the work — job type,
the stack it ran against, the lens it served. An agent strong on one stack and
weak on another appears as two records rather than one average true of neither.

It improves without anyone maintaining it. Every judgement is evidence, failures
included: an agent that cannot do a job here has answered a question, and that
answer is as useful as a success.

## Opinionated, deliberately

This platform has opinions and enforces them. One disposable worktree per run.
Never push. Escalate every decision. A review before a landing, and a complete
one. Canon compiled into every prompt. A verdict on every run before the next one
routes.

That is not incidental strictness; it is the product. Models are inconsistent —
the same prompt on the same tree gives different work on different days, and gets
less predictable as the task grows. The structure around them does not vary.
Holding the process rigid is what converts an inconsistent generator into a
consistent outcome, and every opinion above exists because its absence cost
something real that is written down beside it.

The cost is honest and worth stating: if you want to work a different way, this
will fight you. The opinions are not suggestions and they are not configuration.
Making them customisable — your structure, enforced with the same rigour — is a
coherent thing to build and is not what this is. That is a decision, not an
oversight, and not a priority now.

## A rule binds while it stands, and is replaceable

Canon binds in one direction only: while a rule is written here it is not to be
worked around, reinterpreted into nothing, or excepted for the case in hand. If it
is written, it holds.

It does not bind in the other direction. Canon is where an answer was recorded so
it would not have to be re-derived. It is not evidence that the answer is still
the best one. The authority in this repository is best practice, current solutions
and evidence-backed improvement; canon is their record, not their source.

**The default is open.** Any rule may be challenged on evidence, and nothing here
is defended on the grounds that it is already written down.

**Closure is explicit or it does not exist.** A question that has been argued and
settled says so in its own entry, with the reason, and is thereafter closed.
Silence closes nothing, and an absent objection is not a settled one.

**The failure this prevents leaves no trace.** An agent reads a rule, stops, and
builds the lesser thing, because the better thing would have meant proposing a
change. It exits zero, breaks no test, and is indistinguishable afterwards from a
decision someone made deliberately. Every other failure in this repository
announces itself; this one is silent, which is why the rule is written down rather
than assumed.

**Replacing a rule is a deliberate act.** Bring the evidence and the replacement
together, name what is overruled, and record the ruling. The rule holds until that
happens: proposing a replacement is not licence to act as though it already
landed.


## What we build, and what we buy

Beyond the value proposition, lean on tried and tested. Do not hand-roll and do
not reinvent.

Build only what IS the product: the routing algorithm and the evidence model, the
worker contract and its escalation, review tiers and reviewer calibration, canon,
docs and the context injection that binds a prompt, and the attribution metric.

Buy everything else, and prefer what another project on this machine already runs
in production: authentication and organisations, database access and migrations,
tenancy enforcement, transports, queues, object storage, hosting.

A hand-rolled mechanism where a proven one exists is a defect, not a preference.
Name it and replace it rather than extending it.

## Measure the class before fixing the instance

The escape detector was patched three times at the instance on one day, each
patch correct for the run it named, before the harness-health surface priced
the class in a single table: 25 runs, 4.9 hours, sixteen of them another
project's checkout changing under a worker that never touched it. That number
chose the fix in minutes. The patches had chosen nothing.

So the mechanism that monitors a failure class ranks above any fix for its
latest instance. When planning an epic, put the surface that measures a class
first; when proposing a fix, cite the number a surface already shows; when a
fix lands, say what the surface shows afterwards. A fix without a measurement
behind it is whack-a-mole, and the next instance arrives by a path nobody
anticipated.

## Tasks: inbox zero

File a task for work being done NOW. Do not carry a backlog of ideas.

A plan is not a set of tasks. Plans live in the doc store and become tasks at
implementation time, not before. A board listing what someone might one day do
cannot be read for what is actually happening, and every stale row costs a
session the time to rule it out.

This does not weaken "you file it, you fix it": a defect found while doing other
work is still fixed or delegated in that session. It forbids the speculative
backlog, not the record of real work.

### The suggestion box

Inbox zero only works if noticing something has somewhere to go that is not the
board. That place is the suggestion box.

It is **not a document**. It is a row and one verb — `orch note "<text>"`, on the
CLI and over MCP — because a shared markdown ledger works only while exactly one
session writes it, and two sessions appending a file is the lost-update class
this estate has already met elsewhere.

**An entry is one line of free text, and nothing else is asked of the author.**
Project, run, branch, session, commit and any `file:line` in the text are derived
at write time. A schema nobody fills in is a schema that gets skipped, and the
cost of filing has to stay below the cost of ignoring what you just saw.

**De-duplication happens at write time, by search, never by a job.** Writing a
note shows the nearest existing entries; saying "same" increments that entry's
count and appends a sighting rather than creating a second row. The count is the
promotion signal, which is the rule this canon already carries: a thing seen once
is an observation, and seen twice with cost it has earned a task. A scheduled job
must never merge entries by text similarity — five distinct findings about one
subsystem are five findings, and a similarity pass would have collapsed exactly
that case on the day the mechanism was designed.

**Staleness is mechanical, not editorial.** An entry is stale when its anchors
are gone: the `file:line` no longer exists, the run row aged out, the branch
landed or was deleted, the commit range fell behind trunk. The scheduled job
MARKS stale and may DELETE only what is stale and count-1 and untouched for
thirty days and never promoted. Anything else is a human's call.

**Promotion is a human act.** `orch note promote <id>` files the task carrying
the entry body and its sightings as evidence. The job never promotes, and the
board never grows on its own.

**The guardrail:** if an entry needs fields beyond text, tags and sightings, it
has stopped being a note and become a task. Promote it. Do not build a second
tracker inside the first one.
