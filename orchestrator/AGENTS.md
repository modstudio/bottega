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
  That fallback is gone: the bridge id is never an identity, `sessionId()`
  returns the primary id or nothing, and a mutation that needs an owner refuses
  rather than proceeding under the shared id.
- `orch pending` lists your own unscored runs and exits non-zero while any remain.
- A **Stop hook** raises them before a session finishes, once per turn — it stands
  down if it has already asked, so it can never trap a session in a loop. The
  note listing stands down after one listing per session.
- `orch answer` and `orch continue` refuse escaped and confinement-unverified
  chains, naming `orch confinement clear`. Unread `orch tell` messages are
  surfaced at the harness checkpoint before the final parse. Every write verb
  prints usage on `--help` with no side effects. The heartbeat keeps the last
  stderr line on a DEGRADED tick.

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

## Every repository run is disposable

Any job that reads a repository runs in its own throwaway worktree. Before the
agent starts, orch carries the caller's visible git state into that tree:
committed branch work, staged and unstaged tracked changes, deletions, binary
changes, and non-ignored untracked files. Ignored runtime state is provisioned
by the project's worktree recipe instead of copied from another checkout.

The worktree is the safety boundary. A repository agent gets workspace-write
for that tree and its linked-worktree git metadata directory. A writing worker
also gets the common object store, whose content-addressed objects are immutable
and additive, and the directories holding its own run-branch ref and reflog.
The ref guard permits only that exact branch; the main checkout, trunk and
config remain outside its authority. Do not use danger-full-access for a
repository run. Jobs whose
entire context is inline, including `summarize` and `review-lens-inline`, create
no worktree.

**A registered main checkout stays clean; work happens in a worktree.** Before
a run is created for a project, dispatch refreshes that project's main index
and refuses tracked modifications, naming the dirty paths and the worktree
directory to use instead (both anchored lines). Untracked files warn and do
not block; ignored files are silent. Default on; a project opts out with
`{"requireCleanMain": false}` in its register settings. Resumes skip the check.
The known end state is a bare main with trunk as an ordinary worktree; that is
recorded as `orch doc show bare-main-end-state --scope project --subject bottega`
and is not built here.

A review agent may edit and execute tests to verify a hypothesis. Those edits
are scratch evidence, never a proposed patch: the review's findings are its
product, and a review worktree diff must not be landed. Implement and fix agents
may commit to their own run branch; they may not push, merge into trunk, or
rewrite history. Review agents do not commit, push or merge. Admission to trunk
is a GitHub pull request, merged on GitHub after the local gate passes.

## Review lenses and reviewer calibration

A lens is a sealed core with one global identity. It is one narrow, named viewpoint applied independently to the artifact. It
owns one question, explicitly excludes questions owned by other lenses, reads
the actual diff and checkout rather than the builder's conclusion, loads canon
from its authoritative source, and returns evidence-bearing findings under the
fixed review schema. Review work is read-only. Synthesis happens after the
lenses, and evaluation is a separate act that re-derives each finding.

Its variable payload is a named, versioned profile selected per axis by the
project. Profiles belong to nobody: two projects selecting one profile share
one row. A profile is selected, never inherited, overlaid or merged; when no
selection exists the axis uses its profile named `default`. Content follows the
selected profile. Reviewer precision follows the stable core identity, so a
profile change does not fracture calibration evidence.

Every findings-producing job requires `--lens <stable-id>`. This applies to
`review-lens`, `review-lens-inline`, `safety`, and `craft`. `verify-claim` is not
a lens: it answers one claim with true, false, or undecidable, so it keeps its
answer contract and does not enter reviewer calibration.

The review schema requires severity, location, evidence, and proposed
correction for every finding. It also requires machine-readable provenance:
standards read, effective model, files covered, commands run, and what could not
be verified. Orch measures the reviewed tree at dispatch; an agent's optional
claim about the tree is not consulted for coverage. An empty findings array is a completed clean
review only with provenance showing what was read, including a covered file from the measured
change when its changed paths can be established. Without that coverage the run is an
`unevidenced` failure of the agent, not a clean result; missing or malformed output is not a review.
A review is pinned to the change it read: its stable patch id and touched path
set, with the reviewed tree retained as a secondary fact. A rebase over
disjoint trunk work that preserves that patch keeps the review, as does a
commit-message-only amendment. Rework changes the patch and outdates the row;
landing names each exact lens to re-run against the tip. Overlapping trunk work
still requires review of the composition even when git replayed it cleanly.

A measurement job — diagnose, understand, file-question — returns what it measured or says why not. The caller names the tables at dispatch; each is delivered, blocked with a reason, or not applicable. A conclusion without its table is unevidenced, the same class as a clean review with no coverage.

Reviews are recorded when they happen and begin incomplete. Triage is a later
act by the architect: each finding becomes accepted, modified, rejected, or
skipped, and a review may be completed only after every finding is triaged.
Thus an untriaged review remains visible rather than becoming indistinguishable
from one that never ran.

A findings run records that incomplete review itself when its parsed reply
terminalises. `orch judge` is the close-out verb: it records the score, review
grades, finding triage, review completion and any pair verdict together. A pair
means the same task: root runs with the same job and identical caller-prompt hash, and
for findings work the same lens; their input trees must also match when both
runs recorded one.

**Evidence identity is one tuple:** the caller prompt (`spec_sha`), the change
(stable patch-id plus touched path set), the lens, and the effective model.
Gates, pair offers, voids, reminders and routing each consume the dimensions
relevant to their question from that tuple; none substitutes bound-prompt hash,
tree identity, agent name or row status for one of them.

Reviewer precision is:

    hits      = accepted + modified
    triaged   = accepted + modified + rejected
    precision = hits / triaged

Skipped findings do not enter either side. Precision is computed over the most
recent 50 complete review runs and is null below the named evidence floor,
never zero merely because evidence is absent. The three most frequent rejection
categories travel with it. Calibration keys on stable lens plus the agent orch
actually selected and records the effective model. A model-specific cell is
preferred once it meets the floor; otherwise it falls back to the lens-agent
aggregate, and remains null when that is below the floor too.
The source projects' reviewer tiers do not transfer: orch routes external agent
harnesses and records the exact effective model, which is the evidence key here.

Orch appends the calibration line only after routing, because only then is the
selected agent known, and before hashing and storing the bound prompt so the
line sent remains auditable. Routing reserves space for that suffix when it
tests argv prompt limits.

Precision measures false positives among findings raised. It says nothing
about defects the lens missed: recall requires seeded defects or escaped-defect
attribution and is not claimed here.

## Routing

A job declares the capabilities it needs; an agent that lacks one is excluded
rather than ranked. Among the eligible, history decides — but only once a job
has **5+ judgements**. Below that the declared preference wins, because a score
from two runs is noise and routing on it would lock in whichever agent happened
to go first.

Pairwise judgements are collected at score time because humans give A-vs-B
judgements more consistently than absolute grades, and a fan-out already
produces the pairs. `orch stats` reports Bradley-Terry strengths once a job has
enough duels. Routing still does not use them; the evidence accumulates first.

An off-policy backtest cannot decide a routing change from this judgement log
because disagreements have no counterfactual outcome. The standing challenger
draw is the online experiment that can.

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

**Thompson sampling is the live ranker.** The shrunk score is the posterior
mean; a real dispatch draws from that posterior so accumulated evidence can
still be challenged without pretending a small observed difference is certain.
Status surfaces use the posterior mean instead, so reading a guide or `orch
pick` does not spend a draw or make the answer jitter. The unproven and standing
challenger rates remain separate: they answer whether an agent has been tried
enough at all, while Thompson answers which proven agent the evidence supports.
The standing-challenger floor decays from 10% with the proven leader's judgement
count in that evidence cell, bottoming out at 3%. A model swapped behind an
agent name starts a fresh model-specific posterior and does not inherit the old
model's mean; until it has enough of its own judgements it is unproven and
enters through that decaying floor.

For findings jobs, reviewer precision breaks a tie inside the noise band when
the named lens has enough triage evidence. A measured precision outranks an
unknown cell; an unknown is not zero. Precision never reaches across a real
quality gap, because false-positive rate is supporting evidence, not a
replacement for whether the agent did the job well.

Findings jobs route on the named lens once at least two eligible agents each
have five judgements in that lens cell; with only one eligible agent, its five
judgements suffice. Until then they use the job-wide cell, so correctness and
migration-safety can separate where evidence supports a comparison without
starving either into a premature preference. A lens cell never combines with a
stack cell, and a run enters it only after its lens has been recorded with the
review; unrecorded runs remain job-wide evidence.

A failing behavioural canon eval closes exploration for the default eval agent
until that eval passes. It does not erase proven routing evidence and it does
not override an explicit `--agent`: the failure says not to spend experimental
traffic, not that every established use is invalid. Harness failures are not
wrong answers and therefore do not close exploration.

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
levels do that where numbers do not. The corpus is 1,425 judgements (`orch
stats`, measured 2026-09-06) and five decide a route, so consistency is worth
more than fineness — and the existing distribution shows a ceiling, not a shortage of levels. Ties are
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
not exist. A run's evidence identity is the caller prompt (`spec_sha`), the
change (`patch_id` and path set), the lens, and the effective model; pair
offers, the unevidenced gate, void, pending, the Stop hook and routing keys
read that tuple.

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
has its own bound: `EVIDENCE_WINDOW=40`, the most recent judgements for a job,
agent, and the agent's current model. A vendor silently swapped the model behind
an agent and the new model inherited the old model's mean as though nothing had
changed. Evidence for an agent now uses only that current model's rows, so a
swap starts a fresh posterior. The decaying standing-exploration floor is what
keeps a thin new model from routing on noise before it has its own sample.

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
orch runs --json        the run list as one JSON object per line, with cwd and session id
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
**denied**, **content refusal**, **truncated**, **escaped**, **confinement
unverified**, or **other**. A truncated run hit the vendor's output ceiling
before emitting a result; it is not evidence that the agent was wrong. Quota,
auth, unreachable, escaped and confinement-unverified are the five a person has
to act on, because nothing downstream can route around them, so each raises a
macOS notification at the moment it happens rather than waiting to be found in a
log.

An **escaped** failure means an outside change overlapped the run's own diff.
It is classified and attributed (lock holder, landing session, or unattributed),
never fails over to another vendor, and landing that chain is refused even with
`--unreviewed`. A non-overlapping divergence is recorded on the run and does
not fail it. **Confinement unverified** means a checkout in the frozen watch
set could not be sampled after the run; it has the same terminal and
landing-blocking effect, but records an observer failure rather than a change.
A checkout unavailable before launch is excluded with a warning that names the
stale register entry. The detector never drops findings, scores, or the review.

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

A vendor **content refusal** fails over immediately, but neither cools the
agent nor counts as routing evidence. It describes the vendor's policy for the
shape of that prompt, not the agent's competence or its availability for an
unrelated job. Keeping it distinct from a headless tool-permission `denied`
makes security-shaped prompts countable without teaching the router a false
quality verdict.

## Infrastructure and policy failures are not verdicts

**`unreachable` is not evidence about the agent.** A box that is switched off
never ran at all. Folding that into the mean lets an unplugged machine teach the
router that the local model is bad at the job it is measurably best at.

The incident is recorded in `orch doc show local-model-host-incidents --scope machine`.

So the rule is: **`unreachable` is excluded from the evidence count entirely.**
Not weighted down, excluded. Content refusals are excluded too, for the distinct
policy reason above; quota, auth, interrupted, truncated, escaped,
confinement-unverified, harness and abandoned failures are likewise excluded
where they say nothing about the agent's competence.

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

`orch do` blocked until the agent answered, and that made concurrent review
impossible to run. A lens takes about six minutes.

Review breadth follows a tier computed as the higher of risk and cognitive
size. Risk comes from the surface touched, never from line count. Tier 0 means
the architect reads the diff and runs no lens; until tier-0 recording has its
own mechanism, land it with `--unreviewed "tier 0: <reason>"`. Tier 1 runs one
`correctness` lens. Tier 2 runs `correctness` plus the surface lens:
`migration-safety` for `db.ts`, `craft` for a new module, or `teardown-safety`
for `worktree.ts`. Tier 3 is tier 2 with a second model on at least one lens.
One lens round per tier is the default. Counting lens rounds on the branch, not
fix rounds, tier 0 permits none, tier 1 one pass with no re-lens, tier 2 at most
two rounds, and tier 3 at most three; after the third, the architect stops and
asks the operator instead of dispatching a fourth.

After a fix round, re-lens only at tier 3 or when the fix itself touched a
tier-3 path. Otherwise the architect reads the fix and lands it. Real findings
are fixed. Small and formatting findings are fixed inline in the same round,
without re-review. Speculation is dropped in triage as `below-bar`; file it
only when it is high or critical, or observed in a real run. The loop ends.

These tier boundaries are a first guess. Move them from the per-tier
calibration as evidence accumulates. Nothing enforces them yet.

## A drain loop: how it starts and how it ends

### START

A drain loop starts from a `hub task list` snapshot. The sessions working it
split that board by cluster, give every task one owner, and send the split;
ownership assumed rather than announced produced collisions. Dispatch stays
within the lens and local-gate capacity available to drain it. About eight runs
per session was the ceiling before gates began losing to load. Read
every branch's tier from `orch review tier` before dispatching any lens, because
the tier sets the review budget rather than ratifying it afterwards.

### FILING

A finding becomes a task only when it blocks admission or was observed in a
real run that cost real time. Fix anything smaller inline on the branch that
surfaced it, or reject it in triage as `below-bar` and put the reason on the
review row; filing every observation is a loop that cannot end. A mechanism gap
seen once belongs as a comment on the nearest existing task. Seen twice with
cost, it has earned a task.

INLINE is the default for anything smaller than a task, and it applies to what a
session finds while working, not only to review findings. An issue that fits in
one commit the architect can read in a minute — a wrong name in canon, a stale
sentence, a fixture the trunk moved under, a missing column in a statement, a
one-line guard — is fixed on the branch at hand, or on a fresh branch cut at trunk
and submitted the same hour at tier 0 or 1, with no task; the commit or task note
names what was fixed and why, so the record carries it without a row on the board. The
gate still runs. Two limits: an inline fix never touches a path under a freeze,
and an inline fix that grows past one readable commit was a task all along —
stop and file it. Today's evidence: a claim statement missing a column, two
fixtures rewritten under DEV-311, a gap table naming functions that never landed
and a restored canon section were each fixed in place; none would have been
worth a row, and each would have sat unaddressed as one.

### TRIPPED

When an agent or gate trips — a harness refusal, lockout, dead resume, or unrelated gate failure — ask one bounded question, answered within a minute and not studied:
**Has this class tripped before today, or did two checks collide?** If no, patch it now:
one worker, one round, the violated invariant named in the spec, no task, then move on;
treating a small issue as a design problem made it big. If yes, step back: name the
mechanism — which lock, check, open, or state — and the broken or missing invariant,
then fix the class at the core once under one task. Every further instance is a comment
on that task, never a task or patch: a trip files zero tasks or one, never a chain.
Record the decision and one-line reason on the nearest task before dispatch. Six
refusals, three lockouts, and two lock starvations were patched until DEV-321 named the
class and the patches collided; holding the model fix was decided in one sentence.
Answer from the record, not memory: `orch search <mechanism keyword>` reads score notes, rulings, review findings, and saved outputs; run it and the
task duplicate search on the trip's one-line description, then read what past tasks established before deciding.
A hit is the class task: comment there and decide whether to patch or step back from its record, not by re-deriving it; those two commands take thirty seconds and precede every dispatch.
One patch of a mechanism is allowed; a second aimed at it is the signal to step back, because
continued patching proves a class and search reveals the count. Each of six harness refusals was decided from session memory;
DEV-318 was named only when search found DEV-239's ruling under it after the third patch.

### REVIEW

Tier decides the lens count as above. The architect reads an inline fix round
after a lens and before opening the pull request; do not re-lens it except at tier 3 when the fix itself touched the
hot path. The per-tier round ceilings are hard: reaching one means stop and ask,
not dispatch round four. Read both lenses in a tier-3 pair before writing their
single fix round, because acting on half the review defeats the pair.

### ADMISSION

Run the local gate on the reviewed branch, push it, and open a GitHub pull
request. GitHub is the admission queue and squash-merge folds checkpoint
commits. Merge conflicts, including migration-journal collisions, are resolved
in the branch and gated again. Merge on GitHub; afterwards the main checkout
pulls the landing branch and runs migrations. Carry a lens from an older tree
manually with DEV-270's four facts instead of re-lensing it. Rebase a branch
that has fallen behind trunk in the same breath as its resume or lens dispatch;
the harness refuses a stale caller. A red gate is a real finding: fix it or
report it, without a retry path that can turn the same failure green.

### END

The loop ends when the board is empty or every task left is held by a named
operator ruling recorded on that task, or owned by another session's announced
sequence. Follow the orch-status skill's `CLOSE OUT` section: discard each
landed run's worktree, remove its branch, close every `LANDED` task still open,
record the day's calibration observations on DEV-305, and offer a resume brief.
A session with unscored runs, unclosed landed tasks, or held worktrees has
paused; it has not ended. The Stop hook closes out every terminal tree owned by
the session: clean trees and their provisioned resources are released while
branches survive; dirty trees and explicit `--keep-tree` holds are named with
their resolving command.

## The lifecycle: states, locks and the invariants they protect

A run: `reserved → attached → running → asking → ok | failed | stopped | stale`; a chain inherits its last turn's state.

A branch: `cut → built → reviewed → pull-requested → merged | abandoned`; rework outdates its review.

Trunk moves through a GitHub pull request merged on GitHub.

There are two lock purposes, and two lock files. Worktree creation
and resume attachment take `worktree.ts:withWorktreeCreateLock` (`orch-create.lock`),
and cleanup from discard, abandon, stop and sweep takes
`cli.ts:withCleanupLock` (`orch-cleanup.lock`). Creation protects a new tree
through provisioning and attribution; cleanup protects ownership checks and
removal. **One lock per purpose.**

Attachment and cleanup of the **same** worktree also take a
per-artifact lease named `tree-<hash>` of that path
(`worktree.ts:withWorktreeLease`). The lease is always first and the purpose
lock second, so these operations cannot interleave on one tree and cannot
deadlock.

The invariants are:

- **No limit loses staged work.** Writing runs checkpoint staged and modified
  tracked files on their run branch every ten minutes and once more on wall,
  quota, context, cost, or operator stop. The checkpoint row binds its commit
  to the worker's explicit `progress.json` task pointer; continuation receives
  that pointer and recent branch history. Stop keeps the worktree and branch.
- **The guard lives outside every root the worker can write.** A guard the
  constrained party can delete is advisory; it is published under the common
  git dir, which is not a writable root, and dispatch refuses a run whose guard
  path falls inside one (DEV-248).
- **Orch never edits a vendor's trust store.** Grok trust left for a removed
  orch worktree is residue, not a hazard: each tree path carries a unique run id
  and never recurs, so sweep reports the entry for manual pruning (DEV-194).
- **Every write transaction is IMMEDIATE; a deferred transaction that later writes is a lock-upgrade race under concurrent dispatch.**
- **Divergence is classified and attributed, never fatal by itself.** At launch
  the detector freezes, for the run's own project main checkout and the caller
  checkout, the tree hash (`git write-tree` of the index plus a hash of
  untracked non-ignored paths) and HEAD; at exit it re-hashes. Porcelain is a
  field of that freeze, not a second detector and not `outside_worktree_writes`.
  A sample taken within one second of the checkout's index
  mtime is untrusted and re-taken. A HEAD that moved with a clean tree is an
  edit-commit cycle by someone else. Attribution is the index.lock holder pid
  and its session, a historical landing row that moved HEAD, or unattributed.
  The project register declares the landing branch that the main checkout pulls.
- **The watch set is the run's own project plus the caller checkout, never a
  third project.** Measured 2026-09-07: 25 escapes in a day, 4.9 hours, sixteen
  of them another project's checkout changing under a worker that never touched
  it. A change elsewhere is not this run's escape.
- **Only an overlapping outside change blocks admission.** If the run's own
  diff overlaps the divergent paths the run is `escaped` (`confinement:
  overlapping outside change`) and no pull request opens until the architect rules;
  otherwise the run completes with the attributed event on its row. Evidence is
  never dropped by the detector: findings stay in `orch result`, the run stays
  scoreable, and a review records itself. The chain root and trip-time tip are
  snapshotted so `orch confinement clear` needs neither `--tip` nor hand seeding.
- **A resume is always possible on a stale checkout.** The caller-at-trunk check
  stops a new dispatch from stale input; it must never apply to a chain resuming
  in its own worktree, nor to `--base` / `--cwd` forms that name a recorded run's
  tree. The exemption is granted from explicit resume identity only: the chain
  being resumed (`opts.resume`) whose recorded worktree is the caller cwd, or a
  `--base` / `--cwd` that resolves to exactly one recorded run's worktree path or
  branch tip (equality on realpath or on the commit, never a suffix, never a
  table scan). A stale new dispatch from a checkout that merely happens to be
  some other run's recorded cwd is not exempt. Resume attachment takes the
  creation lock only for attribution, and takes the per-artifact lease first.
- **Only the main checkout's binary migrates the store.** `ORCH_DB` locates a
  store; it never authorises a linked-worktree binary to migrate it.
  `database-location.ts:resolveDatabase` separates location from write authority.
  `db.ts:initializeDatabase` and `db.ts:migrateDatabase` refuse when
  `DATABASE_RESOLUTION.linkedWorktreeBinary` regardless of how the path was
  chosen. `orch migrate` (main-checkout binary only) applies the ordered,
  checksummed SQL files in Drizzle's journal and prints each applied version;
  opening a behind store refuses before application queries run. The migrator
  stamps `PRAGMA user_version` with the applied journal length after each entry
  and on every migrate even when nothing is pending; `user_version` 0 is
  unstamped, not behind. `db()` reads it at open and at the start of every write
  transaction: a process whose journal is shorter than the store refuses the
  write (both anchored lines). `orch mcp` and `hub serve` re-read it on each
  request and re-prepare (and re-advertise tools) instead of refusing. Migrations
  run under one `BEGIN IMMEDIATE` lock on a schema-lock row so two binaries
  cannot apply at once. Each SQL file may declare a `-- BACKFILL` /
  `-- /BACKFILL` block that migrate re-executes idempotently; hashing uses the
  DDL only so a backfill can evolve. `spec_sha` is backfilled in TypeScript on
  every migrate. The ahead ceiling keys on idx (applied count vs journal
  length), not the last entry's `when`; a when-unordered journal is still
  refused at load. After a GitHub merge, the main checkout pulls and runs
  `orch migrate` and `hub migrate`.
  `schema.ts` is the typed declaration, but Drizzle Kit's generator is not
  authoritative for this SQLite store: it cannot preserve table UNIQUE
  constraints or COALESCE expression indexes, so migrations are hand-written
  SQL whose baseline is trunk's canonical DDL verbatim. Tests bootstrap scratch
  stores through `db.ts:applySchemaForFixture` / `bootstrapFixtureStore`, which
  call the journal runner, never the production authority path. The runner reads
  Drizzle's checksummed journal shape but applies each hand-written SQL file
  under that one lock; it does not reach into Drizzle's private migrator session
  or dialect. Expand-first for any column a running process still reads.
  `db.ts:adoptRunMutation` governs chain ownership, not schema authority.
- **A linked-worktree binary reads the main store and never writes it, whatever
  names the path.** `ORCH_DB` locates a store; it never authorises a write. The
  dispatcher exports the live path to every worker (`run.ts`), so a worker's own
  `bin/orch` opened it for writing whenever `ORCH_DB` named it, and on
  2026-09-07 a worker's test leg emptied 27 tables that way — the third instance
  of DEV-314's class after DEV-153 and DEV-314 itself, each patched at the path
  it arrived by. The mechanism, read off the residue: `test/fixture.ts` takes
  the store's directory as its scratch, and a test leg started without the
  preload (from the repository root, or naming a file outside `orchestrator/`)
  inherited the exported live path, initialised a git repository inside the
  main checkout's `orchestrator/` at 08:07, and wrote the live database. That
  nested repository then made every `orch` run from `orchestrator/` resolve a
  store that did not exist, which is what the heartbeat had been reporting. `db.ts:linkedWorktreeReadOnly` now refuses at the point the
  write handle opens when the binary is linked and the path is the main
  checkout's store, under any name; `ORCH_DB_WRITE=1` is the operator's
  explicit insistence. Four kinds of prevention compose here: the weapon is
  removed (the test preload mints a fresh store per test and contains no
  clearing statement), the capability is restricted (this guard), the point of
  damage is guarded (the preload and `test/fixture.ts` each refuse a store the
  preload did not mint under the temporary directory), and the vector stays honest (the register's worktree
  note says the live path is read-only from a tree's binary).
- **A lock waiter is served in arrival order.** Otherwise a stream of short
  holders can starve a long waiter. `worktree.ts:withProjectLock` records waiters
  whose names start with a monotonic ticket taken under mkdir-atomic discipline
  and acquisition consults that order.
- **Every wait, refusal and invalidation on a shared resource is recorded where
  it happens.** The shared resources are a project's trunk, its main checkout,
  the stores, CPU, vendor quotas and walls, review evidence, the register, and
  the purpose locks. `contention` is the ledger: each site writes its row in the
  same transaction as its own record. `orch health` prices the class per
  resource per session. Never inferred later, and never routing evidence.
- **Every refusal names the invariant it protects and the command that clears
  it.** A refusal without both leaves an operator unable to distinguish safety
  from mechanism or to recover without reading source.
- **A reclaim removes exactly the acquisition it classified as stale, never a
  replacement.** A reusable pathname is not identity. Reclaim fences by an
  incarnation id written into the lock owner record and checked after rename
  before removal. Liveness classification parses process identity strictly and
  treats malformed or locale-dependent output as unknown, never stale.

| gap | invariant violated | code path (file:function) | what chunk 3 changes |
|---|---|---|---|
| DEV-348 live-store lifecycle rows | a linked-worktree binary cannot write run or project rows to the registered main store unless `ORCH_DB_WRITE=1` explicitly authorises it | `db.ts:db`, `db.ts:writableDb` | linked-worktree reads remain available; an explicit scratch `ORCH_DB` remains writable; naming the registered store is location, not write authority. |
| DEV-314 | only the main-checkout binary migrates | `database-location.ts:resolveDatabase`; `db.ts:applySchema`, `rebuildTable`, `initializeDatabase`, `migrateDatabase` | closed in chunk 3 (`5cb76a2`, round 2): location is `ORCH_DB`; `initializeDatabase` refuses a linked-worktree binary regardless of path; `orch migrate` is the operator command; fixtures call `applySchemaForFixture`. |
| DEV-316 | one lock per purpose; FIFO waiters; per-artifact lease | `worktree.ts:withWorktreeCreateLock`, `withProjectLock`, `withWorktreeLease`; `cli.ts:withCleanupLock` | creation and cleanup use separate purpose locks; lease first, purpose lock second; waiter names start with a monotonic ticket. |
| DEV-318 | a chain resumes in its own stale checkout | `cli.ts:continueRun`, `detach`; `run.ts:preflight`, `run`, `namesRecordedRunTree`; `worktree.ts:assertCallerAncestry` | closed in chunk 3 (`5cb76a2`, round 2): exemption from explicit resume identity only; query by the identity in hand; stale new dispatch from a recorded cwd is not exempt. |
| DEV-224 review 142/143: replacement race | reclaim only the classified acquisition | `worktree.ts:reclaimStaleProjectLock` | closed in chunk 3 (`5cb76a2`, round 2): incarnation id fenced after rename; env-driven pause after classification before removal. |
| DEV-224 review 142: locale-dependent birth time | a live holder is never classified stale by observer locale | `worktree.ts:processStartTime`, `staleProjectLockHolder` | closed in chunk 3 (`5cb76a2`): `LC_ALL=C` birth string; legacy null startTime is liveness-only. |
| DEV-224 review 143: malformed process output | indeterminate liveness cannot prove staleness | `worktree.ts:processStartTime`, `staleProjectLockHolder` | closed in chunk 3 (`5cb76a2`): strict parse; malformed output is unknown, never stale. |

Chunk 3 landed the candidates from DEV-224-orch-2185 (reviews 142/143), taking the helper names and the conservative null-startTime fallback, and rejecting the classify-before-rename reclaim, index-based guard diff/restore, and locale-dependent `ps` parse.

Chunk 2's harness proves these by simulation. A change to the core names which
invariant it serves and which it might weaken.

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

An implement or fix worker gets a **throwaway git worktree**, a spec, and a
contract. It edits freely and may commit to its own branch, because commits make
units of work and authorship visible. It may not push, merge into trunk, or
rewrite history. The branch diff is still the thing the architect judges.

The harness checkpoints staged and modified tracked work every ten minutes and
at every limit or stop. A worker may rely on that safety net, and records the
last completed item in `$ORCH_SCRATCH/progress.json` after each item so a new
turn resumes from an explicit task pointer rather than inferred prose. GitHub
squash-merge folds checkpoint commits into the pull request's merged commit.

This is an authorship boundary, not ceremony. A run once returned with four
thousand lines of another session's uncommitted work carried into its tree, and
the result looked exactly like worker scope creep until somebody recognised the
code. Had the worker committed its own units, the carried content would have
remained outside those commits and the contamination would have been structural
rather than a matter of recognition. `changesIn` stages everything and diffs
against the immutable run base, so committed and uncommitted work still appear
together in `orch diff` while their authorship remains visible in history.

The architect runs the gate on the reviewed branch, pushes it, opens a pull
request, and merges it on GitHub. The main checkout pulls afterwards and runs
migrations.

**An architect session with files to commit while workers are running uses a
worktree, not a branch in the shared checkout.** This is the same rule as the one
below, arriving from the other side. The harness's own default — if you are on
the default branch, branch first — is correct everywhere except here, where every
writing run watches the main checkout: cutting a branch there converts an
ordinary commit into an escape classification for somebody else's run, and then
into a moved HEAD that nothing detects. Branching is not the mistake. Branching
in the checkout the workers are watching is.

**Landing happens in the disposable worktree, never the main checkout.**
DEV-120/121/122 were once landed in the main checkout; conflict markers were
left in `cli.ts`, breaking `orch` for every session on the machine and stranding
seven paid runs (DEV-129). Long runs also race a moving trunk — `0f8681b` became
`512aaa9` inside one hour on 2026-09-03 — which is why rebasing first and proving
the result with gates afterwards are part of landing rather than optional
cleanup.

The sandbox permits edits in the throwaway checkout and staging through that
worktree's own `.git/worktrees/<name>/` metadata directory, so gates that inspect
the index can run. Writing workers put new objects in the common object store:
objects are content-addressed, immutable and additive, so their commits remain
readable after the worktree is removed. Their only other shared write is the
directories containing the run branch ref and reflog, and the
reference-transaction guard refuses every ref except that exact branch by name.
Trunk remains mechanically protected even when every object is already common.
Read-only jobs keep scratch objects isolated in their worktree metadata. `orch
diff <id>` is the deliverable — what it DID, as against `orch result`,
which is what it SAID. Those are different claims, and checking an agent's work
against its own summary checks nothing.

**Done describes the work, not the knowledge.** When you are about to derive
something, ask whether a landed task already established it. Its comments,
scoring notes and commit message keep the standing they had when written;
consult that record instead of deriving it again.

```
orch do implement "<spec>"      route, cut a worktree, build
orch inbox                      decisions a worker stopped to ask about
orch answer <id> "<ruling>"     rule, and resume it where it stopped
orch diff <id>                  what it actually changed
orch discard <id>               throw the worktree away (the row stays)
```

`orch discard` and `orch abandon` remove the disposable worktree but keep its
branch when that branch has commits reachable from nowhere else; `--force` is
the explicit instruction to delete it anyway. The refusal names both the commit
count and that command. A run that committed nothing still discards routinely.
Once worker commits land anywhere else they stop being unique, so their run
branch also discards routinely. Abandoned unique commits remain because they
are real, judgeable work, not worker debris. A merged branch is recoverable
from the GitHub pull request before its worktree is discarded.

## You file it, you fix it

Filing a task is not a way to put work down. A session that discovers a defect
while doing other work fixes it or delegates the fix in that same session;
filing alone is reserved for work that is genuinely blocked or genuinely
someone else's. A filed-and-unfixed defect is indistinguishable from a fixed one
on the board, and the defects that survive are precisely the small environmental
ones everyone learns to route around. That is how every worker on this machine
ended up quietly handing back diffs containing a stray binary.

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

**A reply is a file.** Every contract names its JSON schema and requires the
worker to write `$ORCH_SCRATCH/reply.json`. The harness reads that artifact
first and falls back to the final message only when it is absent. Native schema
flags remain an extra guarantee where a harness provides them; they are not the
carrier, because ACP defines no result object or output-schema field. The
registration probe must write and validate this file before the row is eligible.

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
  "readonly_create": "scripts/worktree readonly-add --path {path} --base {base}",
  "readonly_notes": "what a READ-ONLY worker is told this detached tree can and cannot run",
  "readonly_remove": "scripts/worktree readonly-rm --path {path}",
  "remove": "scripts/worktree rm {name}",
  "sweep":  "scripts/worktree sweep",
  "seeds":  ["none", "--bundle=minimal", "--full"],
  "notes":  "what the WORKER is told about the infrastructure it has"
}
```

A job that declares `readsRepo` without `writesRepo` does not use `create`, its
branch template, seed resolver, or seed list. orch cuts a plain git worktree at
a detached HEAD of the resolved base, and removes it with plain git, even when
the project declares a writing recipe. `--key` is optional and remains useful
for attribution; `--seed` is refused because seeds belong to writing runs.

A project may explicitly declare `worktree.readonly_create`, using the same
template form as `create` with exactly the `{path}` and `{base}` placeholders.
This command must create a detached worktree,
must have no side effects on task state, and must provision nothing outside the
tree. Its tree is removed with plain git by default. A project that needs
tree-local teardown may declare `worktree.readonly_remove`, which receives
`{path}` only; writing-run `remove` and `sweep` are never used for it. Do not
infer this capability from `create`.

A project may declare `worktree.readonly_notes` beside `readonly_create`: the
project's verbatim account of what its detached read-only tree can and cannot
run. The capability is declared, never inferred from the project's lifecycle.

Without `readonly_create`, a read-only worker in a project that declares a
worktree lifecycle has files only: no databases, generated env, vendor tree, or
other provisioned infrastructure. Its worktree note says so and tells it to
record suites that cannot start in `could_not_verify`, not as findings.

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

The listed seeds are common choices, not an allowlist. `--seed` carries the
project's whole spec through unchanged, including named bundles and flags that
only that project understands. Before a row or worktree exists, orch asks an
advertised `scripts/worktree resolve` to price that spec. Exit 0 accepts it,
exit 2 rejects it, and exit 1 means it could not be checked and is also a hard
stop; a project whose tool advertises no resolver passes through unvalidated.

**The worker is told what it has, in the project's own words.** A worker that
does not know it can serve its own branch on its own port will verify against
whatever is already running — a different branch's bundle — and that does not
fail, it PASSES against the wrong tree.

## A tool that cannot see its data refuses

It never reports emptiness as a finding. "No rows", "no task", "nothing to do"
and "0 affected" are answers a tool may give ONLY when it has looked at the
right data and found nothing there. When it cannot reach the data at all —
wrong directory, a database it may not read or write, missing configuration —
it exits nonzero and names the data it could not reach. The same holds for
machine-readable output: a caller parsing a number must receive an error,
never a zero.

Four instances on 2026-09-03, all the same shape:

- `hub task show DEV-153` from a worktree answers "no task DEV-153". hub.db is
  gitignored so no worktree has one; hub opens an empty database and reports
  the task as absent. Worker specs that told a worker to read its task body
  from hub had therefore been running on whatever the inline spec said.
  Nothing was built wrong only because those specs happened to be
  self-contained. (DEV-154)
- The DEV-137 migration script opened a worktree's empty orch.db and printed
  "0 child rows would be resolved". A session nearly closed the task on that
  number.
- hub's docSet test believed it had isolated ORCH_DB, silently reached the
  real database, and was revealed only by a permission error. The cause was
  Bun.spawn inheriting the environment as of process start: the environment did
  not fail to be READ, it failed to be PASSED. Those are indistinguishable from
  the caller's side and have different fixes, which is what makes this an
  instance of the rule rather than merely an example of it. (DEV-153)
- orch printed a styled run id into a pipe, so callers parsed 0 or NaN instead
  of failing. (DEV-152)

Absence and failure are the two cases a caller cannot tell apart from a
successful-looking empty result — and both of them look like good news. Every
incident above was a session believing good news. That is why the burden sits
on the tool to refuse, rather than on every caller to remember which empty
answers are trustworthy.

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
same cwd and claims monitor conditions addressed to the starting session. When
the resume list is non-empty it appends the list and one sentence —
ask before loading on `startup`/`resume`, offer to resume on `clear`/`compact`/`fork`.
It never fetches a brief body and never resumes anything itself. Addressed monitor
conditions use at-least-once delivery: a hook reads without consuming, emits, and
only then acknowledges, so interruption may repeat a notice but cannot lose one.
Unowned findings remain in the monitor report. During a session
`hooks/orch-heartbeat.sh` reads and acknowledges the same addressed stream. These
two hooks are the delivery paths: the machine-wide monitor does not push into a
harness channel. On any error, timeout, or missing binary the
SessionStart hook exits 0. Register it alongside the other hooks with an absolute
path in Claude settings:

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
somebody still owes a verdict on. It reports what it kept and why. A restore
path that runs SQL checks table and constraint counts after, never exit status
alone. Then each project's own sweep runs, because a
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

The preamble's cost argument makes the value of an escalation depend on
the question being right, and that understates it. A worker told to
reconcile a stale checkout after a landing, using a specific git primitive,
declined the ruling and wrote down why. Its stated reason was true but not
the important one; its own proposed alternative was also wrong — it
narrowed a race rather than closing it. By both of the usual measures the
escalation failed. It is nevertheless the only reason a silent no-op was
not landed. Two sessions had ruled on the primitive, one had tested it, the
other had independently confirmed it, and both were wrong for the same
reason: they tested a state the code would never face. The worker's refusal
is what made someone test again. Nothing about its question was correct
except that it stopped the work.

**The value of an escalation is the interruption, not the correctness of
the question.** A worker that stops on a mistaken concern has still put a
second pair of eyes on a decision at the moment before it became expensive.
A worker that guesses correctly has not.

An escalation is never marked down for being wrong — not on fidelity, which
the canon already protects, and not on quality either. If asking is only
safe when the question turns out to be right, workers learn to ask only
when certain, and certainty is the state in which asking is least needed.

An architect who overrules an escalation should say what made the concern
reasonable. A worker whose objection is dismissed without acknowledgement
learns the objection was noise.

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

## Project facts are declared, not inferred

orch is project-agnostic. Every fact that differs by project belongs in that
project's register row, declared in a shape the dispatcher can read and act on —
not in orch's code, not in checked-in markdown, and not buried inside a string
that something later greps.

All four forms have already cost real work. Whether a project supports `--base`
is decided by `create.includes('{base}')`, a substring search on a shell command
string. Whether one `--seed` becomes one argument or several depends on whether
the template's author happened to quote the placeholder, invisible at the call
site and different by project. No project declared its trunk, so three consumers
silently defaulted to `main` — including the sweep's own merged-check, the thing
standing between a mis-aimed deletion and a lost run — although four of five
projects do not have that branch. A porting feature put four project names, their
product domains, directory layouts and tracker tool names into checked-in
markdown beside 34 live task keys belonging to other projects.

**An inferred capability fails at the moment of use; a declared one fails at
registration.** The first costs a worktree, a vendor clone and someone's
afternoon. The second costs a sentence when the project is set up. Registration
checks the declared landing branch against HEAD and any canon integration-branch
rule; pull requests target the landing branch, never a configured production branch.

The reverse mistake is still the same defect. A fact that does not vary by
project must not be copied into project settings: five copies go stale in four
rows. Tracker tool names follow from the tracker protocol the register already
records, so they belong to the shared protocol adapter rather than to every
project using it.

The mechanism depends on the case. The test is whether the fact varies **by
project**; if it does not, it does not belong in a project row however
project-shaped it looks. If the dispatcher must act on it — decide that
something is possible, refuse early, or describe a capability honestly — it
must be readable rather than deduced. Its shape is the smallest one that
answers what the dispatcher actually asks, not the most general one. An
argument list, an enum, a boolean or a shared protocol adapter can each be the
right answer.

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

For this Claude adapter, the architect's web-capable path for the required
pre-spec research is a Claude subagent whose prompt begins `NEEDS-WEB`. The
root canon states the harness-neutral requirement and puts the resulting ruling
in the spec; this is the adapter-specific mechanism that performs it here.

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

## The test gate

The gate is one in-process `bun test` invocation over `orchestrator/src`, with
the test preload, under the shared host-load hold. The hold admits at most two
running gates and also waits while loadavg is at or above ncpu or free RAM is
under 1 GiB; `gate-load.ts` defines that shared limit.

The invocation emits a junit timing artefact and a per-file timing table. The
timing ratchet compares its total with the committed baseline and only moves
down. The spawn rule is fixed: a unit test file measured above 20 Bun spawn or
spawnSync calls fails the gate. There are no size classes, shards, subprocess
test leg, or retry path.

## Agent capabilities are not interchangeable

An agent is a row: harness, backend, and model. The harness is the ACP-speaking
tool, the backend is where inference runs, and the model is the effective model
that run evidence names. None of those three is a capability declaration.

**Capabilities come from `orch agent probe`, never from inference or a model
card.** Registration asks for one exact reply, one real file-tool read, and one
schema-bound reply, then records what happened and the context window the
harness reported (or the declared window when it reports none). An inferred
capability fails at use time and costs a worktree; a probed capability fails at
registration and costs a minute. An unprobed row is therefore ineligible for
repository work, and a row with no declared or probed window is ineligible for
every job with a working set.

- `readsRepo` — can find and open files unaided. **`agy` cannot.** Measured on the same question: 13.0s when the
  text is supplied inline, 3m 59s when it must read the file itself, and denied
  outright on a later attempt — headless mode soft-denies the `RunCommand` tool
  and cannot prompt for it. Allow-rules were tried and did not match what it
  actually requests.

  It produced only two inline runs and negligible evidence, so its registry row
  is disabled and retained solely as the referent for that history. Inline work
  routes to the cheapest enabled inline-capable row instead.

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
  server until that folder has been explicitly trusted. For an orch-created
  worktree, `--mcp` passes scoped `--trust` to both doctor and the worker and
  records the observed new trust headings. A healthy unrelated server such as
  `orch-ask` does not count.

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
orch score <id> <none|partial|full> [wrong|mixed|right] [--better-than|--worse-than|--same-as <id>[,<id>]]
                                                         delivery, quality, and optional duels
orch runs [--unscored]      what ran, what is unjudged
orch monitor                detect and record stuck machine state; --history reads prior passes;
                            --notices claims this session's addressed findings for its hooks
orch search <query>         consult notes, rulings, findings, and saved outputs
orch stats [--job X]        score, median latency, vendor tokens and cost per agent per job
orch guide [--job X]        what to use for what: best, quickest, and what is still a guess
orch pick <job>             who would be chosen, and why
orch metric [collect]       Claude tokens per shipped task — the ratio this exists to move
orch doctor                 agents, local endpoint, routing at a glance

orch do implement "<spec>"  delegate a bounded change; it writes in its own worktree
    --seed SPEC             project-specific database spec, where the project asks
    --key KEY-123           a ticket key, where the project's branches carry one
orch inbox                  design decisions a worker stopped to ask about
orch tell <id> ["..."]       queue non-authoritative context; --file for long notes
orch answer <id> "<ruling>" rule on them, and resume the worker where it stopped
    --q<id> --file PATH     read that question's ruling from a file
orch continue <id> ["..."]  carry on a chain with no open question; --file for a long follow-up
orch diff <id>              what a writing run actually changed
orch discard <id>           throw its worktree away (the run row stays)
orch sweep                  reclaim finished runs' worktrees and their databases
orch project [add|set|remove]  the register: where work lives, and its stack
orch setup-ask              register the live ask channel with codex and grok
```

**Run messages are context, not rulings.** A worker can send one without
stopping, and `orch tell` queues one for the worker to read at a voluntary
checkpoint. The run ledger says `read_at: null` until the receiving side really
reads it; queued is never reported as delivered. A message cannot close an open
question or relax the escalation contract.

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

`local-acp` drives the OpenAI-compatible endpoint through the model-agnostic
Goose ACP harness. Register it on each machine with
`orch agent add local-acp --harness goose --backend vllm --model "$ORCH_LOCAL_MODEL" --base-url "$ORCH_LOCAL_BASE_URL"`,
then probe it. `orch doctor` prints the filled-in command when both variables
are set and no enabled ACP row points at that endpoint. Adding another local
model is another row and probe, not another driver.
`qwen-local` remains only as a disabled legacy referent so its historical runs
keep their meaning.

Being configured is not being reachable: `available()` checks the former,
`orch doctor` checks the latter.

The harness speaks plain `/v1/chat/completions` to vLLM and ACP to orch. Its
registration probe is the authority on file tools and structured output; the
endpoint's `/v1/models` response is the authority on the served window.
`local-acp` must be served at **147,456 tokens or more**: `understand` needs a
131,072-token working set plus a 16,384-token reply reserve. That exclusion is routing
working from a probed fact, not a reason to weaken the requirement.

### The window is a serving flag

It was served at 65,536, and that ceiling excluded the local
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

**Main-checkout edits are refused in the architect harness.**
`hooks/protect-main-checkout.py` is a Claude Code `PreToolUse` hook on `Write`,
`Edit` and `NotebookEdit` only. It denies a tracked-file edit inside any
registered main checkout and names the worktree to use instead (both anchored
lines). It does not run on Bash, so orch commands and ordinary builds are not
blocked. A project that declared `{"requireCleanMain": false}` is exempt, same
as dispatch. Fail-open on a missing database, a malformed payload, or git
failure. This is harness-specific and lives here, not in the root `AGENTS.md`.
Register it beside the other hooks with an absolute path in Claude settings:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/bottega/orchestrator/hooks/protect-main-checkout.py"
          }
        ]
      }
    ]
  }
}
```
