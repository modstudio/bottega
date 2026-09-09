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
routing, tasks, docs, workflows, canon and the machine itself.
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

**There is a remote, and landing goes through it.** `origin` is
`modstudio/bottega`, private.

**Landing is a pull request.** Push the branch, open a PR, let the checks run,
merge on GitHub. Trunk moves on GitHub and this checkout is DOWNSTREAM of it:
after a merge it pulls and runs migrations, the way a deployment does. Never
fast-forward local trunk and call that landed. `orch land` and its local queue
are retired under DEV-450.

**The gate is a workflow rule, not an enforced one.** This repository's plan
provides no branch protection and no rulesets, so nothing mechanically blocks a
direct push to trunk or a manual merge. Go through the PR regardless. Buy
enforcement when a violation is observed, not before.

**The local gate proves a commit; the remote admits it.** Run the gate before
opening a pull request. Its green is evidence for the review, not entry to
trunk.

**A check that skips what it cannot provision is informational, not a gate.**
Until every suite is known to run identically off this machine, treat a remote
green as a report rather than a verdict. A runner that never started the suite
reports success for having run nothing, which is worse than no report at all:
no report prompts someone to look.

**Attribute before you aggregate.** A count of failures is not a rate until
each one has a cause. Attribution is a step, not a disposition, and the moment
a number is most wanted is the moment it is least checked. A tally of
unattributed instances is not a rate, however carefully each instance was
recorded.

## Tasks

Work here is tracked in `hub`, and every task carries a `DEV-` key:
`./bin/hub task list --project bottega`, `hub task new --project bottega --title "..."`.
Branches and commit subjects cite the key, and `orch do` requires `--key`; work naming
no key is recorded against the project with no task and the link cannot be recovered.

**The project register is the authority** on key prefixes, worktree recipes,
per-project notes and on which concerns a project keeps for itself (see above) —
`orch project list --json`. Read it before concluding a project lacks something.
`orch project add` and `orch project set` verify a declared landing branch against
the checkout's HEAD and, where canon names an integration branch, against that;
a mismatch refuses with both anchored lines. The register distinguishes the
landing branch from an optional production branch, and `orch land` refuses to
touch production. `orch doctor` reports a main checkout whose HEAD is not its
landing branch as a register question, never a run failure.

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
docs and the context injection that binds a prompt, the attribution metric, and
the task and workflow surfaces the other projects take from here.

**Preserve the value proposition, not the machinery that currently holds it
up.** Those two are easy to confuse once the machinery is written, because it
is the part you can see. When a subsystem is neither the product nor bought,
it is a liability carrying the product, and it is replaced rather than
extended — however much of it exists.

Buy everything else, and prefer what another project on this machine already runs
in production: authentication and organisations, database access and migrations,
tenancy enforcement, transports, queues, object storage, hosting.

A hand-rolled mechanism where a proven one exists is a defect, not a preference.
Name it and replace it rather than extending it.

### Research before the spec, every task

The build/buy line above is not obvious at the moment of writing a spec, and a
spec written without checking is where hand-rolling enters. So the check is a
STEP, not a disposition: before a task is specified and dispatched, find out
what the current best practice and modern design for it are, and whether the
problem already has a known, proven solution.

The two halves of a task rarely have the same answer. What IS the product is
novel — there is nothing to buy, and searching returns prior art for a
different problem, which is worth knowing precisely so it is not adopted by
mistake. The INTERNAL MACHINERY around it is almost never novel, and a
maintained library usually exists. A task is normally both, and the research is
what separates them.

THIS IS THE ARCHITECT'S STEP AND CANNOT BE DELEGATED DOWNWARD. The architect
does the research on a web-capable path. A worker that cannot reach the network
inherits the conclusion in the spec — the ruling rather than the question —
instead of being asked to check prior art from memory.

Record the negative result too. "Searched, nothing published, everyone
hand-rolls this" is a finding that belongs in the spec, because without it the
next session pays for the same search and reaches the same answer.

### A review round is scoped by the round before it

Round 1 is the only full review. Every later round repeats ONLY the lenses whose
dimension the fix touched, briefed with what the previous round found and told
not to re-derive it. A full repeat is not thoroughness; it is paying again for an
answer already bought.

- **A clean round ends the ladder.** Do not run another to feel sure.
- **Concurrency has a ceiling.** Past four concurrent lenses you buy wall time
  with wall time.
- **Land on the evidence you hold.** When a gate cannot be satisfied, record why
  and land; re-presenting a decision already recommended costs a turn and
  changes nothing.

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

## Tests are bought, not free

A test is written once and paid for on every run, by every agent and every
gate, forever. The question is never "is this tested?" — it is whether this
test earns what it costs.

**Two gates. Both, on every test.**

**Can it fail?** *If the production code were subtly wrong, would this exact
assertion turn red?* If no: strengthen it or delete it. Three smells, flagged
on sight:

- **vacuous** — cannot fail whatever the code does.
- **change-detector** — restates the implementation rather than its effect.
- **over-isolated** — never reaches the real subject.

Assert the observable effect, not the interaction.

**Is it worth keeping?** Weigh the standing cost against the blast radius of
the bug it catches. Write it where failure is SILENT and expensive. Skip it
where the worst case announces itself, and say so in the commit or the task.

**Coverage is a diagnostic, not a goal.** There is no percentage target, and no
rule here requires a test for every change. Do not test what the type system
already proves.

**Must test:** destructive predicates — who owns this tree, is anyone alive on
it, does this claim resolve; ref-guard and lock machinery; teardown and
reclamation decisions; the routing algorithm and its evidence model; scoring
and fidelity arithmetic; canon injection; anything whose failure destroys the
only copy of something.

**Don't test:** argv construction already proven one level down, help and
formatting output, glue that only delegates, anything a typecheck settles.

**Test one level up, once.** The CLI subprocess is the most expensive shape
available and is RESERVED, not default. It earns its place only where the
assertion is about the process boundary itself — real refs, real locks, real
signals, real teardown. Spawning a subprocess to check a validation result pays
end-to-end price for a unit answer.

**Suite time is a shared budget**, and the budget is under two minutes on a
hosted runner. A slow test guarding little makes every future change more
expensive. Prefer deleting it to nursing it.

## Reasonable caution, and a measure for what escapes it

**Take reasonable caution, then build a way to measure what goes outside it.
That is the whole obligation. It does not extend to anticipating every case.**

This is a governing rule. It outranks the instinct to make a thing safe by
enumeration, and it applies to provisioning, teardown, permissions, and every
other place an agent is deciding how much it is allowed to do.

**Standing up and tearing down are ordinary steps, not dangerous ones.** A task
builds and the same task tears down; the pairing is the process, not an optional
politeness at the end of it. An agent that leaves its infrastructure behind has
not been careful, it has moved the cost onto the machine and onto whoever reads
the board next. The only leftovers worth a conversation are the ones a stopped
process could not release. Everything else goes back on the normal path, without
ceremony and without asking.

**"It might be needed later" is not caution.** It is a guess wearing caution's
clothes, and it costs more than it protects. Name what would actually be lost and
say where else it exists. Work committed to a branch is in the branch. A
database that can be provisioned again is not evidence. The narrow set of things
that genuinely exist in one place only - uncommitted work, an unpushed branch,
production data - is the set that earns protection, and it is much smaller than
the set agents typically defend.

**Weigh the stakes honestly.** Almost everything here is local and recoverable,
and the worst realistic loss is a day's work. That is not nothing, and it is also
not production. A caution calibrated for irreversible damage, applied to
reversible work, is not free: it burns review rounds, it leaves resources
allocated, and it teaches agents to refuse ordinary instructions.

**Where a case cannot be established, do the safe thing once and report it.** The
answer to an unrecognised situation is a conservative default plus a visible
record - never a new special case. A default that does nothing and escalates is
correct for every shape at once, including the shapes nobody has thought of yet,
which is why it ends the enumeration instead of extending it. A guard that
handles many cases and misses one is worse than a plain conservative default,
because it invites confidence it has not earned.

**The escalation is the load-bearing half.** A conservative default with no
measurement is indistinguishable from doing nothing, and that is how a system
that meant to be careful stops working at all. Whatever the default declines to
do must surface where someone will see it, and must say which condition it could
not establish - see the section above: the measurement outranks the fix.

The evidence is this repository's own. One teardown guard took three review
rounds, each finding a further exotic shape and answering it with more
cleverness; inverting the default ended it in one. Separately, treating teardown
as somebody else's step left twelve containers, several hundred worktrees and a
thirty-process tree alive behind finished runs. And a rule that kept a worktree
because its run was unscored - caution, by intent - ended up teaching sessions to
refuse an operator's direct request to clean up, on grounds that were not true.

**Every verb declares which question it is asking.** This rule was read in
opposite directions by two sessions within a day of being written, and both
readings were faithful. "Tearing down is an ordinary step, without ceremony and
without asking" licensed deleting a shared resource; "a default that does nothing
and escalates is correct for every shape at once" licensed refusing to. Nothing
above said which question was being asked, so the same paragraph answered both.

The danger was not that two answers exist. It was ONE PREDICATE SERVING BOTH, so
a caller inherited an answer to a question it had never asked. Two questions look
alike and take opposite defaults:

- **Is anyone ALIVE on this resource?** Scoped to what is actually alive, which
  includes a participant blocked waiting on an answer - asking is alive, not
  idle. A finished participant is not alive, and treating it as though it were
  reports work as live that demonstrably is not, which stops the ordinary path
  from ever running.
- **Does anyone still CLAIM this resource?** Every recorded pointer counts,
  whatever its state. Clear the pointers rather than orphaning them.

Do not read that as a lookup table of two scopes; it would drift the first time
somebody adds a third caller. The rule is that each verb states its own question
and gets an answer to that one. A shared helper that answers "who is here"
without saying which sense it means is the defect, however correct either answer
is on its own.

**The conservative default governs DESTRUCTION, not reclamation.** The test is
whether the operation can be undone by doing it again. Removing something that
can be rebuilt is reversible and belongs on the ordinary path; removing the last
copy of something is not, and earns the default plus its escalation. "Teardown"
is not the distinguishing word - the same predicate failed in both directions on
one branch, destroying a resource a live participant still pointed at, and, read
the other way, reporting finished work as live and disabling the path built to
reclaim it.

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
thirty days and never promoted. Anything else is a human's call. That job is
`hub note stale` (mark vanished anchors and reap eligible notes) and
`hub note curate [--scheduled]`, switched by
`hub note curator [--enable|--disable]` - named here because the paragraphs
above describe its policy in detail while leaving a reader no way to find,
run or disable it.

**Promotion is a human act.** `hub note promote <id>` files the task carrying
the entry body and its sightings as evidence. The job never promotes, and the
board never grows on its own.

**Filing is `orch`, disposition is `hub`.** You file with `orch note "<text>"`
and then keep, promote, drop or merge with `hub note keep|promote|drop|same`
(`hub note list` shows what is outstanding). One noun, two binaries, and the
split is not guessable - this line exists because canon named the wrong one and
two sessions independently concluded the verb did not exist at all, each
generalising from a command that failed for the reason canon had given them.

**The guardrail:** if an entry needs fields beyond text, tags and sightings, it
has stopped being a note and become a task. Promote it. Do not build a second
tracker inside the first one.
