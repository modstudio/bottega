# Orchestrator

A personal delegation layer. It routes work to **external** agents, records what
each run cost and how good it was, and uses that history to decide who gets the
next job of that kind.

## What it is for

Claude's allotment is the scarce resource on this machine, and it is already at
the top tier — there is none left to buy. The only remaining variable is
**Claude tokens per unit of shipped value**.

A Claude subagent bills that same allotment. An external agent does not. So the
substitution this exists to make is:

> work that used to spawn a Claude subagent now spawns `codex`, `grok`, `agy`,
> or a local model — and Claude keeps the **design**, the judgment, and the
> synthesis.

## Claude was the implementer, deliberately. That has changed, and why matters

This file used to say Claude stays the implementer: it leads SWE-Bench Pro
(80.3% against Codex's 64.6%), and implementation quality protects the
**denominator**, because a cheap wrong answer costs a rework round and makes the
ratio worse while looking like a saving.

Every word of that is still true. What changed is that the reasoning had a
hidden premise: that a delegated implementation is a **guess** — an agent hits
an ambiguity in the spec, resolves it silently, and builds on its own answer.
That is what makes a cheap wrong answer likely, and it is the real content of
the standing objection to fanning out implementation at all. Cognition's
write-up is the clearest statement of it: parallel workers make conflicting
*implicit* decisions and the results do not merge. Anthropic's own multi-agent
post, which measures 90.2% over single-agent on breadth research, still names
most coding tasks as the case for keeping one thread.

The load-bearing word in all of it is **implicit**. A worker that must stop and
ask whenever it reaches a judgement call turns an implicit decision into an
explicit one and routes it to the single place holding the whole design. So the
shape that is safe is not "many agents implementing"; it is **one agent building
one bounded spec, escalating every design decision to the architect**.

That is what the rest of this section is for, and it is why implementation could
not simply have been switched on. Delegating implementation without the
escalation contract would have been the mistake this file warned against. With
it, what is delegated is the typing and not the thinking:

| | who |
|---|---|
| design, architecture, the spec | Claude |
| every decision the spec did not settle | Claude, asked for by the worker |
| writing the code | the agent |
| reading the diff and judging it | Claude |

The SWE-Bench figure is still the reason `fidelity` is a scored axis and the
reason a worker's diff is reviewed against the spec rather than against its own
summary. Being right about the denominator does not stop being true; it becomes
something to protect deliberately rather than by keeping the work.

## Scoring is not optional

`orch score` is the only thing here that measures whether delegation works, and
it is the step most easily skipped — the answer has arrived and been used by the
time it is due. Three things make it structural rather than remembered:

- Every run records the **session that made it**, from `CLAUDE_CODE_SESSION_ID`.
  Only that session can judge it, because only it read the output — and
  `orch score` **refuses** a run belonging to another session (`--force`
  overrides, for correcting a verdict you know to be wrong). It used to
  read `CLAUDE_CODE_BRIDGE_SESSION_ID`, which exists only while Remote Control is
  connected and is *shared between sessions on the bridge*, falling back to
  `CLAUDE_SESSION_ID`, which does not exist at all — so 26 of 66 runs recorded no
  session, and runs from a concurrent session landed on another's backlog.
- `orch pending` lists your own unscored runs and exits non-zero while any remain.
- A **Stop hook** raises them before a session finishes, once per turn — it stands
  down if it has already asked, so it can never trap a session in a loop.

**Never score a run you did not read.** A guessed verdict teaches the router
something false, which is worse than the visible gap an unscored run leaves.
That is also why nobody may score another session's runs.

That last sentence was here, and on its own it did not hold. On 2026-08-31 two
concurrent sessions each scored the other's runs within an hour, neither
intending to: `orch do` prints a run id only when a long run **finishes**, so
during a parallel fan-out you are holding outputs with no ids, and "my second
block of ids continues my first" is the natural inference. It is wrong exactly
when a concurrent session's runs have interleaved into the gap — the case nobody
pictures, and one that sequential use never exposes. Both sessions found it the
same way: a Stop hook naming unscored runs they thought they had already scored.

So the rule is now a gate rather than a sentence, and the refusal names the
owning session — because "not yours" tells nobody what to do next, whereas a
session id makes asking the obvious move. On this machine that is a SendMessage
away, and it is how both halves of that incident were corrected: each session
re-scored its own runs from output it had actually read.

## The two halves of the ratio

Every command here drives the numerator down. **`orch score` is the only thing
that measures the denominator.** A run nobody scored and a run scored badly must
stay distinguishable, which is why scores are a separate table and why
`orch runs --unscored` exists. Delegation that is never scored is delegation
you cannot tell is working.

## Routing

A job declares the capabilities it needs; an agent that lacks one is excluded
rather than ranked. Among the eligible, history decides — but only once a job
has **5+ judgements**. Below that the declared preference wins, because a score
from two runs is noise and routing on it would lock in whichever agent happened
to go first.

Pairwise judgements are recorded because humans give A-vs-B judgements more
consistently than absolute grades, and a fan-out already produces the pairs.
Routing does not use these duels yet; `orch stats` reports them while the
evidence accumulates.

**A run that produced nothing counts as `unusable`.** Routing used to read only
successful runs, which made failure invisible: an agent that fails most of the
time but scores well on the few that land looked flawless. `agy` on review-lens
was one good verdict and two headless permission denials, and the router saw a
perfect record. A failed or abandoned run is therefore folded into the mean at
the `unusable` weight — which is already defined as "nothing came back to judge",
exactly what a failure is — so it costs the agent what a person scoring that
outcome would have cost it, with no separate reliability term to tune. That is
also why the threshold counts **judgements** rather than verdicts: a failure is
evidence about an agent, and the most decisive kind.

**Exploration goes to agents that might win, not to ones already known not to
work here.** An agent whose only history on a job is failure has answered the
question; spending a run to hear it again is not exploration.

**Quality decides alone whenever the gap is real; a tie is broken by facts.**
One verdict step over five runs moves the mean by 0.1, so a gap smaller than
that is not even one judgement's worth of evidence — ranking on it would be
ranking on noise. Inside that band the tie goes first to an agent that spends no
metered quota (local or free, keeping the paid subscriptions in reserve), then
to the faster one by median run time. Median, not mean, because one call that
hung should not decide anything.

**Proven scores are shrunk toward the field before they are ranked.** A five-run
0.8 was outranking a fifty-run 0.65 whenever their gap exceeded the noise band,
despite resting on far less evidence. Each proven agent is therefore ranked and
tie-banded on `(points + MIN_SAMPLE * prior) / (evidence + MIN_SAMPLE)`, where
the prior is the mean raw score of every proven agent on that job. Reports keep
the raw mean beside the shrunk score so the evidence remains visible.

## A judgement has two axes

**DELIVERY: did an answer arrive?** `none` | `partial` | `full`.
**QUALITY: was it right?** `wrong` | `mixed` | `right` — not asked when nothing
arrived, and the schema refuses the combination.

They are separate because the two ways a run disappoints you are fixed by
opposite things. A delivery failure is plumbing: the remedy is a bigger context
window, a capability the agent lacks, a sandbox that stopped denying it, or not
sending that agent this job. A quality failure is judgement: the remedy is a
smarter agent, and nothing else. One ordinal column could not tell them apart,
so it did not.

|            | wrong | mixed | right |
|------------|------:|------:|------:|
| **full**   |     0 |   0.5 |     1 |
| **partial**| -0.25 |  0.25 |   0.5 |
| **none**   |       | −0.5  |       |

**A run is one judgement, not two.** A failure counts as `none` — but only if
nobody judged it explicitly. Counting both the failure and its score made a
single run worth two, and while the weight came out the same either way, the
evidence count doubled: an agent could cross the routing threshold on half the
runs it should have needed.

**No answer is negative, a wrong answer is zero.** A wrong answer means the
agent engaged with the job and got it wrong; it stays a reasonable candidate
that happens to be weaker. Nothing arriving means it cannot do this job here,
and that should actively push routing away rather than merely fail to pull it
closer — or an agent that CANNOT do a job ranks level with one that does it
badly. A failed or abandoned run scores here too, at the `none` weight.

**Three levels an axis, deliberately.** Not five: a scale is only worth its
resolution if the same run gets the same score twice, months apart, and named
levels do that where numbers do not. The corpus is under a hundred judgements
and five decide a route, so consistency is worth more than fineness — and the
existing distribution shows a ceiling, not a shortage of levels. Ties are
already broken by cost and latency, which are facts rather than opinions.

### Measuring the scorer

`orch recalibrate` blindly re-scores old outputs and reports quadratic-weighted
kappa per axis. The three-level scales were chosen for test-retest stability;
this measures whether the same scorer actually applies them consistently,
without changing the original score that routing learned from.

**The vocabulary lives in `db.ts` and every prompt is generated from it.** The
previous scale had `unusable` in the schema and offered it nowhere anyone was
scoring: the CLI hint, the run-completion line, the Stop hook and the gate's
deny message all said `good|partial|bad`. It was used once in fifty-eight
judgements, and run 279 — 57 bytes of vendor error — was filed as a quality
problem because nothing better was on offer. A level that is not offered does
not exist.

**Calibration runs are marked `--probe` and never count as evidence.** A smoke
test that asks an agent to reply `ok` proves the plumbing works and nothing
about the agent. Left unmarked it would vouch for that agent on real work at
full strength, and three of them nearly carry one past the 5-run threshold.
Probes are recorded and can be scored, but nothing asks for one: `orch pending`
and the Stop hook both skip them. A probe is excluded from every query that
routes or reports, so a verdict on one teaches the router nothing - which is the
reason those reminders exist. Demanding it would be friction with no payoff.

**A share of runs goes to challengers.** Without that, the first agent to reach
the threshold is the only one that ever scores again: it owns the job
permanently, no rival can be discovered, and its own decline cannot be noticed.
Unproven agents that might win receive the exploration draw; once a challenger
is proven, `STANDING_EXPLORE_RATE=0.10` keeps testing it against the leader. A
leader held the route for good before that standing draw existed. Scoring exists
to compare agents, so a policy that stops gathering comparisons defeats the
thing it serves.

**Prompt size is an eligibility question.** Grok and agy take the prompt on
argv, bounded by `ARG_MAX`; Codex reads stdin and has no ceiling. A pack too
large for an argv agent excludes it rather than being sent and dying.

**So is context, and that is the one that actually bit.** A job declares roughly
what its WORKING SET needs — not the prompt, which is small for all of them, but
everything that accumulates once the agent starts: files opened, canon fetched,
tool results carried turn after turn. An agent whose window cannot hold that is
excluded, exactly the way one lacking `readsRepo` is, because it is the same
kind of fact.

Two shapes, and the evidence separating them is unusually clean:

| | working set | qwen-local on it |
|---|---|---|
| **errand** — one question, a few files | ~32K | `file-question`: 8s, judged `right` |
| **deep** — read widely, fetch canon, then judge | ~128K | `review-lens` ×4: never once `right`. `understand`: failed on a 400 |

Between them those five runs spent forty minutes and 1.8M vendor tokens to
produce three partial answers and two non-answers. The ceiling was knowable
before any of them started, which is the argument for excluding rather than
waiting for the score to notice: discovery by scoring costs a real run every
time, and the local model kept being handed these by the exploration draw.

Those qwen-local results are from the STARVED era and are not a verdict on the
model; see "An outage is not a verdict" for what the window did to them. The
shapes are still the right two, and the eligibility rule now demands headroom
for the reply on top of the working set.

The declared window is the one the SERVER reports, not the one on the model
card — 131,072 here, against a card that says 262K. `orch doctor` reads it back
from `/v1/models` and says so when the two disagree, because re-serving with a
different `--max-model-len` is a routing change whether or not anyone remembers
to edit the constant.

Cloud agents declare no ceiling. Eighty-odd runs, not one context failure — so
the honest encoding is "not the binding constraint here" rather than a number
copied off a spec sheet. The day one fails on window, the figure goes in and
routing starts respecting it.

**Metered billing is a hard exclusion.** An agent on a per-token API key
converts a flat subscription into spend, which is the thing this avoids.

Retrieval-shaped jobs (`file-question`, `canon-lookup`, `summarize`) prefer the
local model: the work is mechanical, a miss is visible, and it costs nothing.
Judgment-shaped jobs (`safety`, `craft`, `understand`, `review-lens`) prefer
cloud agents, because that is where a wrong answer is expensive — and, since the
local window was measured, because they are the jobs it cannot hold at all.

Preference alone was not enough to keep it out of them. `understand` prefers
grok and codex and the local model was sent one anyway, by the exploration draw.
Preference orders the agents that COULD do a job; eligibility is what says which
ones can.

## Four lenses, none of them trustworthy alone

The ratio is reported against four denominators, because each is wrong in its
own direction and agreement between them is the only real signal:

| lens | blind to |
|---|---|
| per task | work carrying no ticket - **this project is the example** |
| per product line | rewards volume |
| per commit | commit habit rather than effort |
| per file touched | depth of change |

**Files are categorised, not filtered.** Generated output has to come out
whatever else happens: measured over fourteen days it was **82% of all line
churn**, because drizzle rewrites a 25-50k line schema snapshot on every
migration, so adding one column reads as a 23,000-line day. Tests are their own
category rather than deleted - one 16,884-line integration test was the largest
single file in one project's window, so they distort a line count badly, but scoring
them at zero would make writing them look free. Docs and config are separated
for the same reason: the mix is itself information, and a day of config is not a
day of product code.

**Spend is split canon vs untracked.** Work outside the four repos ships no task
key, so counting it against a canon denominator inflates the ratio against work
it never touched. It is reported on its own instead of divided by something it
did not contribute to.

The repo a message belongs to comes from its own `cwd`, with the numbered-clone
suffix stripped - the other machine checks out numbered clones such as `application-0` and
so on. Missing that read 26B tokens of canon work as untracked, 65% of the
window, because most of the estate's transcripts come from numbered checkouts.

## Reading the trend

The chart is **three panels on one x-axis**: tokens per task, spend, and tasks
shipped. The ratio alone hides which side moved - a fall means less spend or
more tasks, and those are opposite stories - so both terms are drawn beside it.

Stacked rather than overlaid on twin y-axes, because a dual axis can make any
two series look related by choice of scale, and each panel scales to its own
maximum, labelled: a tall bar in one says nothing about the same day in another.

Hovering a bar writes that day's numbers into a readout above the chart -
per-task, spend, tasks, and for an excluded day the reason it does not count -
and highlights that day's column across all three panels at once, which is the
point of stacking them.
It replaced a native `title` tooltip, which was slow to appear and easy to miss:
the visible response to a hover was the bar turning dark, which looked like a
button that did nothing. The hover state is now an outline, so the bar keeps the
colour that is its entire meaning.

The panel only re-renders when the metric changes. At a 2s poll it was being
rebuilt constantly, which tore the readout out from under the cursor the moment
anyone hovered - and the metric changes once a day, when the collector runs.


The ratio's direction compares the **halves of the window**, not consecutive
days. Tasks land in bursts - a day with four commits and near-zero spend sits
next to one with the reverse - so day-on-day says nothing. Each half is totalled
and divided once rather than averaged over daily ratios, or a quiet day with one
task would weigh as much as a busy one with thirty. The calendar midpoint of the
window divides the halves; excluded days do not move that boundary.

Two kinds of day cannot be read as a ratio and are excluded, though both are
still drawn, hatched, so the chart never hides what it did not use:

- **Today.** Spend accrues in real time while commits land later, so the current
  day is always inflated - measured at 13:46 it showed 166M per task against a
  64M average purely because its tasks had not been committed yet.
- **A day with tasks but almost no tokens.** That is a gap, not efficiency:
  work done on the other machine, whose transcripts are not on this one. The
  test is proportional, not a literal zero - a day carrying 31k tokens against a
  3.2B median is missing its transcripts just as surely as one carrying none,
  and reading it as 3,939 tokens per task flatters the ratio by three orders of
  magnitude. The threshold scales to the window's own median, so it needs no
  tuning as volume changes.

Correcting for both moved the reading from "improving 13%" to **flat** - the
apparent gain was gap days deflating the recent half. That is the cost of the
rough denominator, and the reason the direction is read rather than the number.

Lower is better, so a fall reads as **improving**. A change under 10% is
reported as **flat**: inside the noise these bursts generate, and calling it a
trend would be reading a direction into scheduling. Below five tasks in either
half it says **unknown** outright - with few tasks the denominator moves more
than the thing being measured.

## One score, reported the same everywhere

`orch stats`, the dashboard matrix and the router each had their own copy of the
aggregate. When the router started counting failures the other two did not
follow, so grok on review-lens read **96%** in both reports and **69%** to the
thing actually choosing an agent — and agy, one good answer against two headless
denials, read **100%** where the router had it at **0%**. The stats command even
carried a comment saying it deliberately shared the router's maths, which had
quietly stopped being true.

There is one `scoreboard()` now and the views call it. Ten small queries instead
of one grouped one: that is the price of not keeping a second definition of the
word "score", and it is worth paying. A test asserts every cell matches
`candidates()` for its job.

## The activity counters and the scores carry different windows

The counters band was lifetime, and a lifetime `failed` or `stale` can only ever
go up. The nine stale runs all predate the try/finally that fixed them, so the
one number that would show the fix working was frozen at the pre-fix count for
ever — a permanent announcement of a bug that no longer exists. It defaults to
seven days now, with 24 hours, 30 days and all-time beside it, remembered
per-browser.

The routing matrix and guide do not take that dashboard window. Their evidence
has its own bound: `EVIDENCE_WINDOW=40`, the most recent judgements for a job and
agent. Within that window evidence is keyed by job, agent and the agent's current
model once that model has `MIN_SAMPLE`; below it, the same agent's evidence falls
back across models. A vendor silently swapped the model behind an agent and the
new model inherited the old model's mean as though nothing had changed. The
model key stops that inheritance once the new model has enough evidence, and
the fallback keeps a fresh model from routing on noise before it does.

The per-repo tallies never take either window: they report activity rather than
routing evidence. The counters sit on a different tab, and the band says so in
as many words rather than trusting that to be obvious.

The runs-tab badge stays lifetime for the same reason — a count that changes
meaning when a filter moves is worse than no count.

`SUM` over an empty window is NULL in SQLite while `COUNT` is 0, so every sum is
coalesced. A quiet day was answering `failed: null` beside `runs: 0`.

## The dashboard lives in hub now

This concern routes and scores. It does not draw a page.

`hub serve` shows routing, agent health, the score matrix and the run list, and
it shows them BESIDE the work the runs were spent on - which is the thing
neither page could do alone. Knowing that AB-2548 is moving and that grok is
three minutes into a review-lens on it used to mean reading two pages on two
ports.

Everything the old page drew has a home: the counters band and the live-run
table are on hub's **runs** view, the guide, health, matrix, subagent gate and
vendor-spend-by-project are on **routing**, and the ratio and its lenses are
**cost / ratio** and **cost / spend**.

The live-run table matters more there than it did here. hub nests a run under
the task it is working on, so a run that names no task has no row to sit under —
that table is the only place an unattributed run is visible at all.

What hub reads is published deliberately, never by opening `orch.db`:

```
orch state [--days N]   the whole payload: guide, matrix, health, totals, gate
orch run <id>           one run's detail, prompt and reply included
orch runs --json        the run list, with cwd and session id
orch score --scorer W   a verdict from a UI, recording who gave it
```

**Two pages must never both compute a score.** That is not a style preference:
`orch stats`, the old dashboard and the router each had their own copy of the
aggregate, and when the router started counting failures the other two did not
follow - grok on review-lens read **96%** in both reports and **69%** to the
thing actually choosing an agent. There is one `scoreboard()`, and hub renders
what it returns rather than deriving its own.

**`--scorer` is the session gate's one named exception.** The gate exists so an
AGENT cannot judge a run it never read; a person clicking a verdict has the
output on screen. The old dashboard bypassed the gate by writing the `score`
table directly, which is the same exception made invisible. Recording who
judged it makes it auditable instead: dashboard verdicts land as
`scored_by = hub-dashboard`.

## When an agent runs out of plan

No CLI here can report remaining quota - `codex`, `grok` and `agy` all lack any
usage or balance subcommand - so exhaustion cannot be seen coming. It is caught
on the failure instead.

Every failure is classified: **quota**, **auth**, **unreachable**, **timeout**,
**denied**, or **other**. Quota, auth and unreachable are the three a person has
to act on, because nothing downstream can route around them, so each raises a
macOS notification at the moment it happens rather than waiting to be found in a
log.

**Routing then avoids that agent for an hour**, unless it is the only one left -
refusing to run is worse than trying an agent that may have recovered. Only the
most recent run is consulted, so a single success clears the state without
anything having to reset it.

**A probe is how you say "I fixed it".** When a person tops up a quota or logs
back in, the tool has no way to know: routing will not send that agent work
while anything else can take it, so the cooldown runs its full hour over a
problem that is already solved. A probe cuts it short —

    orch do file-question --agent codex --probe "Reply with exactly: OK"

— because the cooling query is the ONE place probes are deliberately not
filtered out. Everywhere that measures quality excludes them, since "reply with
ok" vouches for nothing; availability is a different question and a probe
answers it exactly. `orch doctor` prints this when anything is cooling, because
that is where someone looks. Adding `AND probe = 0` there for consistency would
remove the only way out.

## An outage is not a verdict

**`unreachable` is the one failure kind that is not evidence about the agent.**
Every other kind is something the agent did: it ran out of plan, it lost its
login, it was denied a permission, it answered wrongly. A box that is switched
off never ran at all. Folding that into the mean lets an unplugged machine teach
the router that the local model is bad at the job it is measurably best at.

The incident is recorded in `orch doc show local-model-host-incidents --scope machine`.

So the rule is: **`unreachable` is excluded from the evidence count entirely.**
Not weighted down, excluded. It is the only kind treated this way, and the
exclusion is deliberately surgical — a quota failure needs a person too, and is
still an honest fact about what that agent could do that day.

**`unreachable` tells a person but does not cool the agent down.** A cooldown is
for a condition that CANNOT BE OBSERVED WITHOUT SPENDING A RUN — quota and stale
auth announce themselves only by failing, so the only way to stop paying for the
discovery is to stop asking for an hour. Reachability is the opposite: measured
directly before every routing decision, for one HTTP call to a socket on this
machine. Cooling on it buys no information and costs the whole recovery window.

That was not theoretical for long. With `unreachable` in the cooldown list, a
box that had been woken and was demonstrably serving again five minutes later
stayed out of routing for the remaining fifty-five — which defeats the point of
waking it. So NEEDS_HUMAN (who can fix it), COOLS_DOWN (is waiting the only way
to find out) and NOT_EVIDENCE (does it say anything about the agent) are three
separate lists, because they turn out to answer three separate questions.

**Reachability is a routing input, not a run outcome.** `orch do` probes the
local endpoint before it routes, and an endpoint that does not answer makes the
agent ineligible with a reason that says so, rather than being discovered by
sending it work. Configuration is not reachability, and the eleven hours are the
proof: the env var was right the whole time.

The probe is cached per process, because `orch do` lives for one run and a
second probe would tell it nothing. Anything longer-lived refreshes it — `orch
serve` re-probes every minute, or the dashboard would report the state of the
world at the moment it was started for as long as it stayed open.

**`orch doctor` is where you look, so it carries the checklist.** When the
endpoint is down it prints the three things to check in the order they can fail
— the box, the tunnel, the server — and says routing has already excluded it, so
nobody goes hunting for work that is silently failing.

**An agent's window must hold the working set AND a reply.** The eligibility
test was `job.contextTokens > agent.contextTokens`, which admits an agent whose
window is exactly the size of the job. That reads as sufficient and is not: vLLM
allows `max_model_len − prompt_tokens` for the reply, so an agent that can just
barely hold the job has nothing left to answer with — run 279 spent 409s and
325k tokens thinking and emitted no content at all.

The bug hid because the two numbers were far apart for most of this system's
life: a 64K agent against a 128K job. Serving the local model at 131,072 made
them **equal**, which silently re-admitted it to every deep job — precisely the
outcome the ceiling had been added to prevent. Eligibility now requires
`OUTPUT_RESERVE` on top, a 16K floor read off that failure rather than measured.
Recording `finish_reason` per run is what would replace the guess with a
distribution.

## A fan-out cannot be synchronous

`orch do` blocked until the agent answered, and that made the shape of work
this exists for impossible to run. Seven review lenses over one diff is the
NORMAL shape of a review here, and a lens takes about six minutes.

Every caller-side workaround loses the work, and all three were tried in a real
review in one application (runs 407-413):

- **Foreground.** An agent harness caps a foreground command at ten minutes;
  seven contending six-minute runs blow past it and the whole process group is
  SIGTERMed. All seven died `exit 143, empty output`.
- **`nohup ... &` in a background task.** The children did not outlive the
  wrapper shell; every output file stayed at zero bytes.
- **`setsid`.** Not on macOS at all.

That left seven sequential runs, forty-odd minutes of wall clock, for work that
is embarrassingly parallel and that the agents handle concurrently without
complaint.

So detaching belongs HERE, not in the caller:

```
orch do <job> --detach   -> prints a run id and exits at once
orch wait <id>...        -> blocks until they finish (--timeout, default 1800s)
orch result <id>         -> the reply, by id, whenever you ask for it
```

**The id is claimed before the agent is picked.** `--detach` has to print an id
and return, which it cannot do if the id is allocated after routing, so the row
is reserved up front reading agent `(pending)` and `run()` fills it in once it
has routed. The child is spawned with no stdio and unref'd, so it outlives the
process that asked for it - the thing no caller-side wrapper could arrange.

**The asking session still owns the run.** `session_id` is stamped by the
process that ran `--detach` and the worker never overwrites it, so the session
that wanted the answer is the one allowed to score it. Detaching must not become
a way around "only the session that read the output may judge it".

**`result` exits 2 for "not finished" and 1 for "failed".** One code for both
would make a poller give up on its own runs. The output is read from disk by id,
so it survives being asked for twice - the same durability `orch retry` relies
on, and bounded by the same 30-day retention.

**`orch wait` is bounded by construction.** A run whose process died without
writing its row would otherwise be waited on for ever, which is the failure this
command exists to remove rather than relocate.

**`orch retry <run-id>` re-sends the exact prompt to the SAME agent.** A quota
limit or a dropped connection is a fact about the moment, not about the agent,
and routing around it starts a different agent from scratch on work the first
had partly done — which is what happened when Codex hit its limit mid-review and
fresh grok lenses were launched in its place. The retry is linked to the run it
re-attempts, and **the original failure still counts**: the agent did fail, an
hour of routing avoided it for good reason, and erasing that would flatter the
record. Retrying needs the prompt still on disk, so it is bounded by the same
30-day retention as everything else in `runs/`. A writing run is the exception:
its retry continues the same agent session in the same worktree, so the partial
edit and the context that made it are not abandoned for a freshly bound prompt
in a new tree; `orch retry` directs that case to `orch continue`.

**Confirmed against a real exhaustion, 2026-08-31.** Codex hit its ChatGPT usage
limit mid-review (run 314) and the generic pattern caught it first time — the
wording is `You've hit your usage limit. Upgrade to Pro ... or try again at
<time>`, which `usage limit` matches. The cooldown then held it out of routing
for the hour, as designed. So this section is no longer a guess for Codex; agy
and grok remain unconfirmed, and `other` is still the signal for those.

That run is also the case the both-ends truncation was written for, arriving
within hours of it. The banner at the head names the model, provider and
sandbox; the real error is at the very tail, after a screen of MCP tool-call
chatter. Head-only truncation — what the four undiagnosable failures got —
would have stored the banner and the prompt and left "codex failed" as the whole
record.

**A backfill once put 7 of 9 failures in `denied`, and it was wrong.** The
pattern matched a bare `approval`, and Codex prints `approval: never` in the
banner it echoes before saying anything — so nearly every Codex failure was
filed as a permission refusal. Only two runs, both agy, were ever real denials.
The others are `other`, which is the honest answer: their errors were truncated
away and cannot be recovered.

**Keep both ends of a failure, not one.** That truncation is the second half of
the same story. A head-side cut stored the banner and the echoed prompt and
discarded the error; a tail-side cut loses the banner, which names the version,
model, provider, sandbox and approval mode and is often the entire explanation.
Four runs are permanently undiagnosable because only one end was kept. The
prompt is stored separately, so the echoed copy in the middle is the right thing
to drop.

## Delegating implementation

A worker gets a **throwaway git worktree**, a spec, and a contract. It edits
freely and is *told* not to commit, push or merge: landing a change is the
architect's decision under the project's own ship knobs, which an external agent
has never read.

The sandbox permits edits in the throwaway checkout and staging through that
worktree's own `.git/worktrees/<name>/` metadata directory, so gates that inspect
the index can run. New blobs go into an isolated object database inside that
directory and read existing blobs from the common object database as a read-only
alternate. It does not grant the common `.git` directory: the main checkout's
refs, objects and config remain unwritable. Committing, pushing and
merging are still forbidden by instruction, and no post-run check enforces that
instruction. Do not read "never commits" as a guarantee — read the diff. `orch
diff <id>` is the deliverable — what it DID, as against `orch result`,
which is what it SAID. Those are different claims, and checking an agent's work
against its own summary checks nothing.

```
orch do implement "<spec>"      route, cut a worktree, build
orch inbox                      decisions a worker stopped to ask about
orch answer <id> "<ruling>"     rule, and resume it where it stopped
orch diff <id>                  what it actually changed
orch discard <id>               throw the worktree away (the row stays)
```

`orch discard` and `orch abandon` remove the disposable worktree but keep its
branch when that branch has commits not yet on the project's trunk; `--force`
is the explicit instruction to delete it anyway. A worker never commits, so any
commits on that branch are the architect's work in progress, not worker debris.

**`writesRepo` is declared, never inferred from `readsRepo`.** Opening the
sandbox is a separate flag on every agent that has one.

With two exceptions worth knowing, because both were once described here as
harmless: codex's `--approve-for-me` is REQUIRED for MCP tool calls and already
implies workspace-write, and qwen runs `--approval-mode yolo` because headless
cannot answer a permission prompt. So "asked for tools" and "asked for a
writable disk" are the same request on codex. `mcpImpliesWrite` declares that,
and any run that gets a writable sandbox is now put in a worktree whether or not
its job writes — because the worktree is the actual protection and the sandbox
flag is merely how the agent was configured. The failure is silent: an agent that cannot write does not error, it
reports success having changed nothing, and an empty diff looks exactly like a
job that needed no changes. Only codex carries it, because only codex has been
watched creating a file and exiting 0. Grok's first attempt was killed at a
two-minute bound having written nothing — a question, not an answer.

**`resumable` is what makes asking affordable.** A worker that stops to ask has
to be startable again carrying everything it read, or asking costs more than
guessing and nobody asks. grok takes a session id we mint, codex names its own
and announces it in `--json`, qwen names its own and announces it nowhere — so
it is recovered from the chat-recording filename, matched on the PROMPT rather
than on "the newest file". Newest is right until two runs overlap, which is the
normal shape of a fan-out, and this database already carries an incident where
interleaved runs were attributed to the wrong owner.

An invariant at import refuses the case those three make easy: `resumable` must
mean orch can actually resume it, not that the CLI has a flag. qwen had
`--resume` and looked resumable in every help text while being unresumable by
anything here.

**A conversation is one unit of work.** Three turns are three rows and only the
root is evidence — otherwise an agent reaches the routing threshold by being
inquisitive rather than good. The root carries the chain's outcome, which is
what keeps every other query working: a chain that ended well would otherwise be
root=`asking` plus child=`ok`, so nothing would ever be offered for scoring.

**`asking` is read before the success ladder, not inside it.** Exit 0 with a
reply looks like `ok`, and an unfinished implementation recorded as a completed
one scores an agent for work it has not done. A reply that does not parse at all
is a **failure**, for the mirror-image reason: a writing run that never said what
it did has left a diff that could be anything.

## Delegate what is specifiable; keep what is still being discovered

The line is not "Claude designs, agents implement". It is **whether a spec
exists yet**. If the work can be written down well enough that a worker could
build it faithfully, delegate it. If the requirement is still forming in
conversation with the person asking for it, keep it.

**Iterative work with the user does not go to an agent**, and front-end work is
the clearest case. The user reacts to what they see, the next requirement comes
out of that reaction, and each turn is small. Routing that through a worker adds
minutes to a loop that should take seconds, loses the shared context of the
thing both parties just looked at, and asks an agent to guess at taste — the one
thing a spec cannot carry. The same applies to debugging while somebody watches,
to tuning wording or layout, and to anything where the answer to "is this right?"
is a person looking at it.

This is not an exception to the delegation rule; it is the rule stated
properly. Every argument for delegating rests on a spec the worker can be
faithful to — the escalation contract, the fidelity axis, reviewing the diff
against the spec rather than the summary. Where there is no settled spec, none
of that machinery has anything to grip. **Delegation is for work that has
stopped moving.** Iterate until it settles, then delegate the next bounded
chunk.

## A worktree belongs to the project, not to orch

orch cut worktrees with plain git, and in two of these repositories that
produces a directory that looks right and is useless. One application's own script
says what is missing: no generated `.env`, no cloned vendor tree, so compose
interpolates to nothing and **not one quality gate can run in the result**. A
worker handed that runs tests that are meaningless and reports them green,
which is worse than failing.

So a project declares its own lifecycle in the register and orch shells out to
it; a project that declares none gets the built-in git worktree, which is right
where a checkout is just files — this one, for instance.

```json
"worktree": {
  "create": "WORKTREE_SEED='{seed}' scripts/worktree add {branch}",
  "remove": "scripts/worktree rm {name}",
  "sweep":  "scripts/worktree sweep",
  "seeds":  ["none", "--bundle=minimal", "--full"],
  "notes":  "what the WORKER is told about the infrastructure it has"
}
```

**Templates, not arguments.** These tools do not agree and never will: one
takes the seed in the environment, another positionally. A template lets each
project spell its own call rather than orch encoding one project's grammar as
everybody's.

**Bottega is the recipe's first user, deliberately.** An engine with no user is
a guess about what other projects need. This repo declares a recipe of its own —
install its three package roots, no database, and a serve/stop pair — so every
delegated run here exercises the thing, and a worker changing the dashboard can
look at ITS OWN copy on its own port. That last part is the whole reason a
read-only job still gets served: verifying against the dashboard already running
on 7778 tests the MAIN checkout and passes, which is worse than failing.

**How much database is the ARCHITECT'S call.** It depends on what the task
touches — docs need none, a migration needs every table — which is a fact about
the design, and the worker has not seen the design. Where a project lists seeds
and offers no default, orch refuses to invent one: one application removed its default
after finding it silent and leaving every business table empty, and reinstating
it by omission would quietly undo that.

**The worker is told what it has, in the project's own words.** A worker that
does not know it can serve its own branch on its own port will verify against
whatever is already running — a different branch's bundle — and that does not
fail, it PASSES against the wrong tree.

## Docs

Operator docs are markdown facts about an installation, stored in `orch.db`
rather than baked into code. `global` applies everywhere; `project`, `agent`,
and `job` each name a registered subject; `resume` names a project as its
subject (the epic is the slug); `machine` and `global` have no subject. The
dividing test is portability: text every adopter needs unchanged is canon and
stays in the repository, while text describing this estate is a doc.

`orch doc list|show|set|rm` manages individual docs, `export|import` round-trips
the scoped directory layout, `brief` emits the SessionStart operator-doc view,
and `resumes` lists open resume briefs for the project containing `--cwd`. On a
first run, global docs, docs for the job, and docs for the project containing
the cwd are inserted after worktree infrastructure and before the supplied
spec, so their bytes participate in routing. Resume turns do not repeat them.
Agent docs describe vendors as observed here and belong to the router and
architect; machine docs describe the host. Resume briefs belong to the
architect session. Neither agent, machine, nor resume docs are injected into a
worker.

`orch mcp` serves project and doc tools over stdio; `orch mcp --config` prints
the registration object for `~/.claude.json` without changing it:

```json
{
  "mcpServers": {
    "orch": {
      "command": "/absolute/path/to/bottega/bin/orch",
      "args": ["mcp"]
    }
  }
}
```

The MCP SDK is orchestrator's first runtime dependency because this server is
part of the CLI rather than development tooling.

`hooks/session-brief.py` fails open: it asks `orch doc brief` for the cwd and
adds only successful output to a new session, then `orch doc resumes` for the
same cwd. When that list is non-empty it appends the list and one sentence —
ask before loading on `startup`/`resume`, offer to resume on `clear`/`compact`/`fork`.
It never fetches a brief body and never resumes anything itself. On any error,
timeout, or missing binary it prints nothing and exits 0. Register it alongside
the other hooks with an absolute path in Claude settings:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/bottega/orchestrator/hooks/session-brief.py"
          }
        ]
      }
    ]
  }
}
```

## Resume briefs

A long architect session loses its thread at a `/clear` or a compaction.
Claude Code's compaction is lossy in documented ways (it drops file paths and
prior actions), and auto-compaction cannot be given custom instructions at all.
So "where we are and what is next" lives outside the conversation, in the doc
store, and is re-offered when a new session starts.

A resume brief is a doc at `scope = resume`, `subject = <project>`,
`slug = <epic>`. Status lives in the body's frontmatter, not in the address —
a consumed brief keeps the same name so it stays readable. Frontmatter keys:
`status` (`open` | `consumed`), `epic`, `project`, `written` (ISO 8601),
`consumed` (ISO 8601, absent while open).

**Writing.** At a task or epic boundary, draft the brief **in the conversation
as markdown**, and write it only after the operator approves. Never
draft-then-store-then-show; the approval must precede the write or it is
theatre. This is the same rule as never writing a memory without showing the
exact content first. Writes go through `set_doc`.

**Brief contents.** Epic and task just finished; decisions made and the
reasoning that produced them; open `orch` job ids and what each was asked to
build; files and paths touched; and an explicit `NEXT ACTION` line.

**Resuming.** The SessionStart hook lists open briefs; it does not inject a
body. The agent reads the list, asks which (or offers the single one), fetches
it with `get_doc`, then marks it consumed with `set_doc` — flipping `status`
and stamping `consumed`. Declining must not consume anything.

## Cleaning up is a delay, not a prohibition

Nothing reclaimed anything, deliberately: a failed run's half-finished tree is
the most readable artefact here, and cleaning up on failure would destroy the
evidence exactly where it is most useful. That argues for a **delay**. A tree
nobody has looked at in a day is not being read.

`orch sweep` runs nightly and takes only runs that are terminal, older than a
day, and **already scored** — an unjudged run is one whose diff is the evidence
somebody still owes a verdict on. Then each project's own sweep runs, because a
database whose worktree directory somebody deleted by hand is invisible to orch
entirely: no row points at it and there is nothing left to remove.

The directory was never the expensive part. The first automated run dropped
three orphaned databases in one project and kept another project's worktree holding
unpushed commits — neither of which orch could have decided for itself.

## Two ways to ask, and the fast one degrades into the slow one

The durable protocol is `status: blocked` in the return contract. It always
works, and it is coarse — the worker's turn ends and it comes back through a
resume, which is a lot of ceremony for a question answered in ten seconds. A
worker facing three small ambiguities will batch them or, worse, decide two
itself to avoid the round trip.

So there is also a live channel: `ask_orchestrator`, one MCP tool, registered
once per agent with `orch setup-ask`. The worker calls it mid-task, it blocks
until a ruling lands, and the turn is never lost. A sentinel in the output could
not have done this — a wrapper can only grep for one once the process has
finished writing, which is exactly what is being avoided.

**It always answers.** A tool that can hang for ever is worse than no tool: the
worker holds a subscription seat with nothing to wait for, and the run's own
timeout eventually kills work that was finished but for one question. On a
timeout it returns an instruction to stop and report the question in the final
answer — which is the durable protocol — so the fast path degrades into the slow
one rather than into a hang. The question stays open either way, because the
decision still has to be made.

**The run id comes from the environment, never from the tool arguments.** A
worker naming its own run would be guessing, and in a fan-out several are alive
at once, so the guess would sometimes attach a question to another worker's run
and deliver the ruling to whichever was waiting.

**A writing job gets MCP whether or not the caller asked for it.** Telling a
worker to escalate every design decision while giving it no way to escalate
leaves exactly one option, and that option is the one this exists to remove.

**The MCP-versus-sandbox trade is CODEX'S, not the system's.** codex needs
`--approve-for-me` for MCP and that flag is mutually exclusive with `--sandbox`,
so a codex worker chooses between the ask channel and executing the project's
toolchain. grok has no such conflict — its MCP comes from `~/.claude.json`
natively, so nothing competes with its sandbox setting. Verified: with
`--permission-mode acceptEdits` it reported `ask_orchestrator` among its tools
and wrote the requested file in the same run.

**Headless grok must never be able to prompt.** There is no user attached to
answer it, and both `default` and `dontAsk` have prompted for shell commands in
practice; the unanswered tool call becomes a cancellation instead of a denial.
Every grok run therefore uses `bypassPermissions`. The worktree and the
dirtied-tree detector are the guards for read-only lenses as well as workers.

So an implementation worker CAN have both; it just cannot be codex today. That
is deliberately NOT encoded as a preference — grok has no scored implement runs,
and preferring an agent on zero evidence is the mistake this file warns about
twice already. grok is eligible, exploration will send it work, and the score
will settle it. Writing it down only stops the constraint being re-derived as a
limit of the design.

## A third axis: did it build what it was asked to build?

**FIDELITY: `drifted` | `partial` | `faithful`**, judged on writing jobs only.

Delivery and quality cannot see the defining failure of a worker under an
architect. An agent can return a complete change set (delivery `full`) of
correct, working, tested code (quality `right`) that solves a **different
problem** from the one specified — because it found an ambiguity, resolved it
silently, and built on its own answer. Both existing axes score that as flawless.

A penalty rather than a third dimension of the matrix, and the shape is the
argument. Delivery and quality are two questions about one event whose
combinations mean different things, which is what a matrix is for. Fidelity is
not a third such question; it is a discount on an answer that is already good.
Code that solves the wrong problem is not "half right", it is right about the
wrong thing.

| | penalty |
|---|---:|
| faithful | 0 |
| partial | −0.25 |
| drifted | −0.5 |

**Asking is faithful and costs nothing.** The preamble promises the worker
exactly that, and it has to hold in the arithmetic or asking would cost
something after all — which returns us to silent guessing.

**Required on a writing job that delivered something.** `delivery: none` takes
no fidelity, for the same reason it takes no quality: nothing arrived to be
faithful to. Everywhere else the word is demanded, because optional it would go
unused — the
two-axis habit is old here, and a run that looks complete and correct invites
`full right` without further thought, which is precisely the reading that cannot
see drift. Demanding the word forces the question.

**The other half of the judgement needs no judgement.** Files changed, lines
moved, tests claimed, deviations owned up to and questions asked are recorded
automatically — measured facts stored beside claimed ones, deliberately side by
side, because the signal is where they disagree. A worker reporting passing
tests beside a diff touching no test file has told you something, and no verdict
is needed to see it.

## Projects are rows, not literals

Everything here knew four repository names and one person's home directory:
`repoOf` matched `/Users/<someone>/Projects/<name>`, the canon list was an array
literal, the metric walked a hardcoded root. Fine for one machine, and exactly
what made the tool unadoptable — you cannot take up a router whose notion of "a
project" is somebody else's filesystem.

```
orch project list
orch project add <path> [--name X] [--stack Y] [--no-canon]
orch project set <name> [--stack X] [--settings JSON]
```

Resolution is by **containment**, which the regex never managed: a worktree at
`<repo>/.claude/worktrees/orch-123` resolves to its project with no special
case, and the longest path wins so nesting resolves inward. Anywhere
unregistered is `null` rather than a guess.

**One guess survives, deliberately.** `repoOfCwd` in the metric still recovers a
numbered clone (`application-1`) from the path, because the other machine checks
out repositories that are the same repo under a different directory name and
will never be registered here. Missing that read 26B tokens of canon work as
untracked, 65% of a fortnight. It is a fallback for paths the register does not
answer, not a second source of truth — and it is the one place the "no guessing"
rule is knowingly broken.

The register seeds itself once from the run history. That is **data, not code** —
the distinction the whole change is about. A fresh checkout elsewhere has no
history, seeds nothing, and starts with `orch project add`, which is the
intended experience rather than a degraded one.

**The stack is why this is not merely tidying.** Agents are not uniformly good,
and a router keyed only on job type averages "strong on PHP" and "weak on Vue"
into a number true of neither. On the existing corpus the difference is already
visible: `review-lens` routes to grok across all stacks and to **codex** on node
ones. Stack rather than project so two Laravel apps pool their evidence —
two Laravel apps share one, so a verdict from either is evidence about the
other.

**Narrowing needs TWO proven agents on that stack.** One is not a comparison; it
is a smaller evidence base for a decision that would have been made anyway, and
it is actively worse — an agent with thirty job-wide judgements and three here is
demoted to "unproven" and loses to whichever reached five on this stack first.
That is the incumbency problem this file already guards against for exploration,
arriving through a different door. Below the bar, job-wide evidence answers
exactly as before, and `orch pick` says which it used.

## The subagent gate

A `PreToolUse` hook denies Claude-subagent spawns for work an external agent
could do. **Web work is allowed, but it declares itself** — `NEEDS-WEB` in the
first 200 characters of the prompt or description. Only that opening is checked
so a quoted repository excerpt deep in a prompt does not become a declaration.

**A URL is not a declaration.** It used to be, and that quietly restored the
rewording path this gate had just removed: any prompt that happened to quote a
docs link or a stack trace was allowed, without anyone having decided it needed
the network. A URL is now noted in the log and nothing more.

**Denial happens on `PreToolUse` only.** `SubagentStart` carries no prompt to
judge and its schema rejects a permission decision outright, so emitting one
there produced a phantom `denied` row and a hook error beside a spawn that
started anyway. It is audit-only. Everything the gate does *not* deny is
recorded too — `Workflow` above all, which fans out dozens of agents and used to
leave no trace at all, so the expensive path was the invisible one.

It used to guess from phrasing, and that failed in both directions on the same
task: `Research design-system doc practice` was denied, and the third rewording
of it was allowed. The vocabulary list was doing the guessing, so it is gone.

The declaration is not a lock. Anyone can write `NEEDS-WEB`, and preventing
that is not the point: writing it is deliberate and recorded, so a habit of
declaring web work that is not web work shows up in `orch spawns` rather than
hiding inside a regex. That is also why there is no longer a rewording path —
one deliberate act is auditable, three rewordings are not.

**A denial has to name a route that EXISTS.** For most of this gate's life every
job it could point at was read-only, so a session with implementation work to
delegate was denied and handed a menu with nothing on it that fit — leaving "do
it inline" or "try the spawn again" as the only moves. Sessions kept trying to
spawn subagents for implementation, and that was read as a compliance problem
when it was a rule forbidding the only available path. The fix was to build the
path and name it in the refusal, not to word the refusal more firmly.

**Every spawn is logged, allowed and denied alike.** Subagents are ~18% of
Claude spend on this machine (7.6B of 41.3B tokens over 14 days, 63% of it
`general-purpose`), and none of it was attributable before. A gate that cannot
report what it let through cannot be tuned.

## Knowing what to use for what

`orch guide` answers it per job, and names **two** agents rather than one:
quality and turnaround do not have to agree, and when they diverge the right
choice depends on what the job needs.

It reports what it is entitled to report. A leader with fewer than the routing
threshold of judgements is labelled **provisional**, not recommended — under
that many verdicts the leader is whoever happened to go first. It also lists
eligible agents nobody has tried, which is where a run buys the most
information: an empty cell is a question that has never been asked, and no
amount of re-running the incumbent will answer it.

Latency is always shown beside median prompt size. A fast answer to a small
prompt is not a fast agent, and the two are only comparable together.

The guide is deliberately deterministic — it reports the default route and does
not spend the exploration draw, so reading it twice gives the same answer.

## A delegated agent is not a trusted one

An external agent runs a real CLI, with a real shell, in the caller's checkout.
Three limits follow, and each was written after the thing it prevents happened
here:

**Delegation bottoms out at one level.** A review-lens given the orchestrator to
read found the `orch do` instructions in this file and ran one — spawning a
second agent nobody asked for, whose run was then recorded as routing evidence.
`ORCH_DEPTH` is set on every child, and `orch do` refuses to start when it is
already set. An agent that cannot answer with the tools it has hands the
question back; it does not hire someone.

**The child does not inherit this session's identity, or an Anthropic key.**
Every `CLAUDE_*` and `ANTHROPIC_*` variable is stripped. Identity, because a
child that inherits the session id files its own runs against the caller, and
the Stop hook then demands a score for an answer nobody in that session read —
at which point an agent, told it is blocking, will score it. That is the
dishonest evidence this whole design exists to keep out, arriving through the
door marked "never judge another session's runs". Credentials, because a metered
API key is the one cost this layer exists to avoid, and no external agent has any
use for one. Eleven variables were being handed over, including a messaging
socket and token.

**Every run is bounded and every child is reaped.** Each agent carries a
`timeoutMs` set from its measured worst case and held below the stale cutoff, so
a run always writes its own outcome rather than being swept out from under a
process still waiting on it. `SIGINT`/`SIGTERM` take the children down with the
parent, and the terminal row is written from a `finally` — because the row is
inserted *before* the spawn, and the only thing worse than a failed run is one
that never says it stopped. The pid is recorded immediately after the spawn, not
after the wait: written afterwards it was always the pid of a process that had
already exited, so the liveness check never had a live pid to test.

## The dashboard is loopback-only

`Bun.serve` binds every interface unless told otherwise. This server hands out
the full text of every prompt and every reply — whole files from private repos,
whatever a pack quoted — and accepts an unauthenticated POST that writes scores.
On a shared network that is both a reader of the repos and a writer of the one
table here that is supposed to be evidence. It binds `127.0.0.1`, for the same
reason the model endpoint is tunnelled rather than exposed.

## Prompts and replies age out after 30 days

`runs/` holds the verbatim text of every pack sent and every answer returned —
private repo contents, quoted at length — and nothing had ever deleted one. The
row stays in the database either way, so history and scoring are untouched; only
the text ages out, and the dashboard already copes with a path that is gone.

## Parallel launches share one database

A fan-out runs several `orch do` processes at once, all writing the same SQLite
file. `busy_timeout` makes a blocked writer wait rather than fail — without it a
parallel launch loses most of its rows, which is to say the record of the very
runs it was launching. Measured: 8 concurrent writers wrote 40 of 160 rows
before, 160 of 160 after.

## Agent capabilities are not interchangeable

- `readsRepo` — can find and open files unaided. **`agy` cannot**, and this is a
  specialism rather than a defect. Measured on the same question: 13.0s when the
  text is supplied inline, 3m 59s when it must read the file itself, and denied
  outright on a later attempt — headless mode soft-denies the `RunCommand` tool
  and cannot prompt for it. Allow-rules were tried and did not match what it
  actually requests.

  So agy is the fastest of the three at judging what it is handed, and unusable
  at fetching. Give it `summarize` and `review-lens-inline`; never a job needing
  `readsRepo`. Its free tier is not the constraint — inline runs are as quick now
  as on the first call.

  **The pack it needs costs nothing to build, and that is the point that was
  missed.** Assembling a self-contained pack sounds like reading the files, which
  is the cost delegation exists to avoid. It is not. **A diff is already a
  self-contained pack.** `git show <ref>` is 15-17KB for a normal commit, well
  inside a small argv limit, and producing it costs a shell command and no model
  at all.

  Denials of `review-lens` runs taught the same lesson from the other side: those
  packs NAMED their sources instead of carrying them, and an agent that cannot
  prompt for a read tool soft-denies it. Same agent, same size prompt; the one
  that carried its evidence succeeded. Measured results for particular agents
  are in `orch doc list --scope job`.
- `mcp` — can call the MCP servers THAT CLIENT HAS REGISTERED, which is not the
  same as this machine's. That distinction was missing and it cost a session
  seven runs.

  The mechanism works: all the servers are plain stdio
  (`~/.claude/mcp/mcp-run <name>`), so any client that spawns a subprocess can
  use them, and codex needs `--approve-for-me` because `exec` defaults to
  `approval_policy=never` and refuses tool calls outright.

  Grok discovers project MCP configuration but does not start a repo-local
  server until that folder has been explicitly trusted. `--mcp` does not grant
  that persistent trust: a run records the same-named project server's doctor
  result, and `orch result` prints both the degradation and the exact opt-in
  trust command. A healthy unrelated server such as `orch-ask` does not count.

  The capability flag says only that the client CAN speak MCP. So: `--mcp`
  means "this agent can use the servers it has". If a job needs a
  particular server, check that client's registration rather than assuming the
  machine's. See `orch doc list --scope agent` for observed client registrations.
- `schema` — can be bound to a JSON schema for its final message. This is what
  makes a fan-out contract enforceable rather than requested. Grok's
  `--json-schema` takes the schema inline and constrains the model; Codex's
  `--output-schema` takes a path and is silently dropped when MCP tools are
  active. Prefer Grok when the contract must hold.

**Grok takes its prompt on argv, not stdin.** `ARG_MAX` is 1 MB here, so a
sliced pack fits comfortably but a whole one may not. Codex reads stdin and has
no such ceiling.

## Commands

```
orch do <job> [prompt]      route, run, record  (--file, stdin, --agent, --schema, --mcp, --probe)
orch score <id> <none|partial|full> [wrong|mixed|right] [--better-than <id>[,<id>]]
                                                         delivery, quality, and optional duels
orch runs [--unscored]      what ran, what is unjudged
orch stats [--job X]        score, median latency, vendor tokens and cost per agent per job
orch guide [--job X]        what to use for what: best, quickest, and what is still a guess
orch pick <job>             who would be chosen, and why
orch metric [collect]       Claude tokens per shipped task — the ratio this exists to move
orch doctor                 agents, local endpoint, routing at a glance

orch do implement "<spec>"  delegate a bounded change; it writes in its own worktree
    --seed X                how much database, where the project asks
    --key KEY-123           a ticket key, where the project's branches carry one
orch inbox                  design decisions a worker stopped to ask about
orch answer <id> "<ruling>" rule on them, and resume the worker where it stopped
orch continue <id> ["..."]  carry on a chain with no open question
orch diff <id>              what a writing run actually changed
orch discard <id>           throw its worktree away (the run row stays)
orch sweep                  reclaim finished runs' worktrees and their databases
orch project [add|set|remove]  the register: where work lives, and its stack
orch setup-ask              register the live ask channel with codex and grok
```

**`answer` and `continue` are different questions.** `answer` is for a worker
waiting on a ruling, and refuses a chain with nothing open. `continue` is for a
chain with nothing open, and refuses one that is waiting — because resuming a
worker with its question unanswered makes it guess, which is the single thing
this design exists to prevent. `continue` exists because an interrupted chain
had no way back at all: `failed`, its questions already answered, and everything
it had read sitting in a vendor session no command could reach.

**A resumed turn is detached, like everything else.** It was not, and it was the
last place still doing what "A fan-out cannot be synchronous" describes: a
ruling delivered in the foreground outlived a harness command timeout, the
process group was killed, and the worker died having already written a complete
and correct reply. Which the parse then discarded, because it was gated on a
clean exit — so finished work was recorded as "reply did not match the worker
contract". Both halves are fixed; the lesson is that every path which spawns an
agent has to detach, not just the one somebody remembered.

**Both claim paths must set every column that means something.** `detach()`
fills a reserved row through an UPDATE and `run()` inserts a fresh one, and the
UPDATE was missing `parent_run_id` and `turn` — so a detached resume came back
as a fresh root and the chain silently forked.

## Local model

`qwen-local` drives the endpoint with Qwen Code. An earlier attempt used the Codex harness via
`model_providers`, so AGENTS.md reading, `--output-schema` and MCP all still
work with a local model behind them. Set `ORCH_LOCAL_BASE_URL` (and optionally
`ORCH_LOCAL_MODEL`). It costs nothing per call, which makes it the right home
for high-volume mechanical work.

Being configured is not being reachable: `available()` checks the former,
`orch doctor` checks the latter.

**The local endpoint is driven by Qwen Code, not Codex.** Codex speaks only the
OpenAI *Responses* API and sends the `developer` role, which this vLLM build
rejects outright — verified: `system` and `assistant` are accepted alongside a
user message, `developer` returns `Unexpected message role`. Qwen Code speaks
plain `/v1/chat/completions`, so it works, and it is a Gemini CLI fork tuned for
Qwen models, which is what is being served.

Select the endpoint through the **environment**, not `--openai-base-url`: that
flag does not switch it out of Gemini mode and yields an opaque 404.

    OPENAI_API_KEY=local OPENAI_BASE_URL=… OPENAI_MODEL=… qwen --approval-mode yolo -o text "…"

`--approval-mode yolo` is required because headless cannot answer a permission
prompt. Measured: reads a file and answers correctly in **8-10s**.

### The window is a serving flag

**Now served at 131,072.** It was 65,536, and that ceiling excluded the local
model from `review-lens` and `understand` — between them 74% of everything ever
delegated — leaving it eligible for 16% of the work.

The measurements are recorded in `orch doc show local-model-host-incidents --scope machine`.
Check concurrency at the endpoint, not the model card or the last configured
value someone remembers.

That ceiling does not fail the way you expect. An over-length request gets a
clean HTTP 400 naming the number. What actually bites is the OUTPUT budget: vLLM
allows `max_model_len − prompt_tokens` for the reply, so as an agentic loop
accumulates tool calls and results the room for an answer shrinks. Qwen3.6 is a
reasoning model and spends that budget thinking first, so on a hard question
late in a long loop it hits `finish_reason: length` having emitted **no
content** — reproduced directly:

    finish_reason: length
    content:       None

Qwen Code renders that as `[API Error: Model stream ended with empty response
text.]`. Run 279 is the case: 409s, 325k cumulative vendor tokens, 57 bytes back,
and `orch` recorded it `ok` because the process exited 0 with a non-empty reply.
Vendor error placeholders are now recognised and recorded as failures.

**Every deep failure the local model had was this, and none of them were quality
judgements.** Four review-lenses came back `mixed`, `mixed`, `mixed` and one
empty; an `understand` died on a flat 400. All five ran against a 64K window. A
verdict reached while an agent is starved measures the serving parameter, not
the agent — which is the distinction the delivery axis exists to draw, and it
was drawn wrongly here for as long as the ceiling went unexamined.

Unstarved it is **`mixed`**: a complete, engaged answer that found a real latent
defect nobody else had (NOISE_BAND derived from a coincidence) and also asserted
a proof that is false in seven live cases. Useful, and not to be trusted
unchecked.

### The endpoint must serve `/v1/responses`

`wire_api = "chat"` was removed from Codex in February 2026 and is now a hard
startup error — not a fallback, not a warning. So the serving layer is a
dependency rather than a preference: it must expose the OpenAI **Responses**
API, not merely `/v1/chat/completions`.

vLLM serves it. llama.cpp bridges it. **Ollama does not**, which is what rules
Ollama out on top of its inability to batch. Verify with
`curl <base>/v1/responses` before wiring anything, because everything
downstream depends on it.

**Run Codex where it can see the repository, against a tunnelled endpoint.**
Bind the server to localhost on the model host and forward it:

```
# held open by launchd (com.user.local-model-tunnel)
ssh -N -L <local-port>:127.0.0.1:<remote-port> <host-alias>
export ORCH_LOCAL_BASE_URL=http://127.0.0.1:<local-port>/v1
```

That keeps the model socket off the LAN entirely — which matters, because these
servers ship with no authentication by default and NVIDIA's own SGLang notes
carry CVE-2026-7301 warning against exposing the interface. Never bind it to
`0.0.0.0` on a routable interface.

Do not use `--oss` / `--local-provider`: it hardcodes localhost and ignores a
remote base URL, and it runs an Ollama pull workflow that 404s against any other
server. Do not name the provider `oss` either — that key collides with the
built-in one and silently redirects to Ollama's port.

### The box, and what it can actually run

The host, model and measured performance are recorded in `orch doc show local-model-host-incidents --scope machine`.

**No AI attribution, enforced twice.** `hooks/no-attribution.py` runs on every
Bash tool call and denies a `git commit`, `git merge`, `gh pr create` or similar
whose message or body credits an AI (a co-author trailer naming the assistant,
a "generated with" line, a session link), reading `-F` and `--body-file` files
too. The repo's `.githooks/commit-msg` refuses the same patterns for any commit
made outside the tool. The harness appends these trailers by default and will
keep trying; the rule is the house's, and the hook is what makes it hold.
Enable the git side once per clone with `git config core.hooksPath .githooks`.
