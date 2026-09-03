# hub

Every project's work in one view: what is in flight right now, what each task
actually cost, and the daily report that goes out over the top of it.

## The web app

The Vite and React app lives in `hub/web`. Build it there with `bun run build`;
`hub serve` serves `hub/web/dist` at the root. Route modules live in
`hub/web/src/routes`: the filename is the URL, and TanStack Router generates the
route tree. Static files have extensions and are read from `dist`; every other
non-tRPC path receives `index.html`, so a hard refresh on a nested route enters
the same router as a click.

Every screen reads through a procedure in `hub/src/trpc/routers`. Those
procedures wrap the canonical `view()`, `strip()`, `setReport()`, `sendTest()`
and `collectNow()` functions rather than reimplementing their queries or
writes. Projects and Docs likewise reach the orchestrator only through its
published functions. A new screen therefore needs a route module, a procedure
over the canonical operation, and a navigation entry; the browser must not grow
a parallel definition of the data.

The app has no component library. Controls are native elements: button, input,
textarea, table, checkbox (accent-color plus the existing focus ring), select
for the window-bar project and agent filters, `<dialog>` opened with
`showModal()` for Add project and New doc, a tablist with arrow-key navigation
for the Docs scope filter, the `title` attribute where a tooltip was, and a
small toast helper. shadcn/ui and Radix were removed because those primitives
were used in three places and the browser already provides them.

The selected time window, run filters and nav counts are one external store in
`hub/web/src/lib/window.ts`. Screens subscribe with `useWindowState()`, so a
choice made on one route remains true on the next and survives reload where it
is useful. Live query screens poll their tRPC procedure every two seconds and
pause where an open menu would otherwise be redrawn underneath the pointer.
Collection has its own cadence and lease; browser polling only reads the latest
completed state.

Serve the current tree before checking a screen. A server already listening on
7778 may be the main checkout, and a successful response from it proves nothing
about this worktree. Build `hub/web`, choose a separate port, start
`bun hub/src/cli.ts serve --port PORT`, and verify both direct navigation and a
hard refresh there.

Filtering happens before any cap. Capping first makes a filter search only the
already-truncated page, so a busy project can make another project appear to
have no results even when matching history exists.

The tooling project belongs beside the four product projects. It is here
deliberately: it had no tracker, so every hour
spent building this tooling landed in the untracked bucket, which is precisely
the spend that most needed a name.

## What it is for

Two questions the individual trackers cannot answer, because each of them can
only see its own project:

1. **What is in flight, everywhere, at once.** Four trackers and a local table,
   one table on screen.
2. **What did a task cost.** No tracker measures this, and the obvious ways to
   measure it are wrong in ways that are invisible once they are on a page.

## Engaged time is a union, never a sum

This is the whole model, and everything else is plumbing.

Every source emits half-open `[start, end)` spans. Engaged time is the **union**
of them, per task.

| source | span |
|---|---|
| a Claude or Codex transcript | one per adjacent message pair, `[t, min(next, t + idle_cap))` |
| a delegated agent run | `[started_at, started_at + latency_ms)` — no cap; it was busy throughout |

Both of the simpler models are wrong, in opposite directions:

- **Summing per-agent durations** double-counts every fan-out. Runs 378 and 379
  overlapped almost entirely — 379 started 8s after 378 and finished 26s before
  it — so summing claims 7m54s where 4m15s of wall clock happened.
- **Measuring only Claude's message gaps** reports near-nothing for that same
  stretch, because Claude sent no messages while it waited. That is the model
  work-report used, and it is why a day of heavy delegation could read as idle.

A session waiting on a delegated agent is **not idle**, and two agents running
at once did **not** take twice as long. The union is the only reading that is
true of both.

The cap is applied **per pair, not to the total**, which is what makes the spans
unionable: a capped gap keeps its real start, so an agent run can overlap it
instead of merely adding to it.

**The estate total is unioned across every task at once**, not summed per task.
Two tasks worked in parallel in two worktrees occupied one stretch of wall
clock; adding them would claim more hours than the day contains.

## Time and spend are two measurements that share a span

They are not derived from one another, and treating them as if they were cost
1.35 billion tokens on a single day — 32% of it — silently.

The first cut apportioned a leg's tokens across its spans in proportion to
duration. That dates spend by how long a gap was rather than by when the message
landed, and it drops **every** token from a leg too short to have a span at all.
There was no error and no empty column; the number was simply smaller than the
truth.

So each message's spend is charged to the span containing its own timestamp, and
a leg with a single message emits a **zero-length span**: real spend, no
measurable duration. That is the honest reading, and it keeps the token total
conserved — the only property that makes the reconciliation against the day
grain mean anything. It is asserted in the tests for that reason.

## Three currencies, never added together

- `claude_tokens` — Claude Code's own spend, from the transcripts.
- `vendor_tokens` — per delegated agent, **per agent**.
- `vendor_cost_usd` — where the vendor reports it, which today is grok alone.

Vendor tokens are not comparable to Claude's, or to each other. Runs 378 and 379
did comparable work on the same question and reported **452,860** (grok) against
**91,996** (codex): a 5x gap that is about how each vendor counts, not about how
much work happened. A merged "total tokens" column would read as a measurement
and be an artefact.

## Attribution, strongest signal first

1. **The worktree path.** `<repo>/.claude/worktrees/<KEY>` — already universal,
   already in both `run.cwd` and the transcript directory names, and a standing
   declaration by whoever created it.
2. **A commit subject**, which is a claim made at the moment of shipping.
3. **Prompt text**, the weakest of the direct signals: a key mentioned in
   passing is not a key being worked on. Injected payloads are excluded
   outright, and a key belonging to a different project than the working
   directory is ignored — a session in one project discussing another project's ticket is
   not time spent on it.
4. **The branch the work was on**, recorded by orch at run time. Direct
   evidence of the same kind as a worktree path — somebody named it before the
   work started — and it reuses the same matcher, underscore case included.
   Partial by nature and worth saying so: 53 of this estate's 60 branches carry
   a key, but three main checkouts all sit on
   `develop`, and a main-checkout run is exactly the one nothing else names.
5. **A delegated run's FULL prompt**, read from the file orch kept. Same rule as
   above; it exists because `prompt_head` is only the first 200 characters and,
   for the runs that matter, all 200 are preamble. A review lens opens *"You are
   a code reviewer in the project's code-review workflow. FIRST: fetch
   your review…"* and names its ticket well past the cutoff.
6. **The nearest directly-attributed leg of the same session**, for a
   transcript leg that named nothing itself. Weak, and labelled `sibling-leg`
   so it is never mistaken for evidence: on a holdout it is right **39%** of the
   time.
7. **Nothing.** Reported as an explicit unattributed row *per project*.

**The full prompt must be read before anything is inferred, and the reason is
measured.** Runs 451–454 are four review lenses that name `STAR-5364` once each,
filed under `STAR-5309` because that key happened to be committed in the same repository
around the same time. Reading the file took unattributed run-spans from 76 to 22
and replaced 20 wrong guesses. Prompt files are immutable once written, so the
read is cached by path and the two-second redraw never re-reads one.

### The commit window is gone, and it was not close

Nothing is attributed any more by asking "was something committed in this repo
while this ran". It sounds reasonable and it does not work, because in a repo
carrying a dozen concurrent worktrees the answer is usually somebody else's
ticket.

Measured on a **holdout where the truth is known** — legs in a plain checkout
whose own clean user prompt names the ticket, which is exactly the population it
existed to serve — it was right **7 times in 260. Three percent**, about what
naming an open ticket at random would score, while carrying 102 hours and 8.4B
tokens of history. On delegated runs it was worse: **0 of 13** against direct
evidence, four wrong on topic (runs 294/297/304 are Nexus/Stride design-system
work filed under `STO-980`, *"Extract the reprint dialog out of inventory.tsx"*),
and 22 of its 38 decided by a single nearby commit or a tie broken on commit
order.

Its replacement on transcript legs — the nearest leg of the same session that
*was* directly attributed — scores **39%** on that holdout, and **38% against
the window's 2%** where both fire. That is not good, and it is not presented as
good; it is recorded under its own `via` so a per-task cost can be read with the
right amount of trust. It is seeded only from direct attributions, never from
another borrowed key, because chaining would let one worktree leg colour a whole
day.

A commit **subject** is still used, and is not the same thing: that is a claim
the session made about its own work, not a commit merely landing nearby. The
difference between those two is the entire finding.

**A wrong key is worse than no key.** An unattributed row is honest about a
blind spot; a wrong one flatters the total *and* bills a named task for hours it
never spent. This is what `attribute()` means by returning a null key rather
than guessing.

**The project roll-up never moves when task attribution changes**, because the
two are decided by different things — the project by the working directory, the
task by whatever named it. Asserted in the suite, and checked against the
database when the window came out: per-project spans, hours and tokens were
byte-identical before and after.

**The naming convention is not one convention**, and the regex is deliberately
loose about case and separator because of it. All four of these are live:

    .claude/worktrees/AB-2533
    .claude/worktrees/worktree-ADN-703-markdown-render
    .claude/worktrees/technical_sto_986_nexus_shell_barrel
    .claude/worktrees/AB-2548/resources/assets/js

The third is why the key is not anchored to the start of the directory name, and
why the prefix guard is a lookbehind rather than `\b` — `_` is a word character,
so `\b` finds no boundary in `technical_sto_986`. Anchoring, the obvious first
cut, would have dropped every attribution from the project whose worktrees carry underscores while the other three shapes
kept working.

**An unattributed row is not noise to be filtered.** Work carrying no ticket is
the blind spot every denominator here shares, and hiding it would flatter every
number above it.

## It reads the orchestrator through the CLI, not the database

hub needs `run.started_at`, `latency_ms`, `cwd`, `session_id`, `vendor_tokens`
and `vendor_cost_usd`. It gets them from `orch runs --json --since`, which is a
published interface, and never by opening `orch.db`.

A database shared between two concerns is how two concerns quietly become one —
the root canon's line, and the reason `orch runs` grew a `--json` flag rather
than hub growing a second connection.

## What a collect must never do

**Overwrite a good reading with a worse one.** The orchestrator learned this by
losing five days of token measurements that could not be rebuilt: transcripts
are pruned, and work done on the other machine never had any here to begin with.
Git-derived columns may always overwrite, because history is still there and a
later pass measures them at least as well. Token columns may not.

**Downgrade a tracker's task row to a git-derived one.** A task the MCP server
described knows its own title and status; git knows neither. The git leg seeds
rows for tasks no tracker could reach, and updates timestamps, and stops there.

**Key a transcript's spans on the session id.** Several `.jsonl` files can carry
the same `sessionId` — a sidechain transcript is written alongside its parent —
so clearing by session made the second file delete the first file's rows. 387 of
1040 intervals vanished in the same collect that wrote them, and it read as a
gap in the early hours of a day rather than as a bug. Spans are keyed on the
**file**.

## Collection runs on a clock, and exactly one process does it

The collector used to run only when a person typed `hub collect`, so the page
showed whatever was true the last time somebody thought about it — reporting
"nothing running" straight through a live fan-out, on a reading nine minutes
old. A dashboard that has to be refreshed by hand is a report.

Two cadences, because the legs cost very differently. Transcripts and runs are
local reads over a **two-hour** window and take ~300ms, so they run every 20
seconds; the trackers are four remote round trips taking seconds, so they run
every five minutes with git. Two hours rather than the whole window because a
span that changed is a recent one, and re-reading thirty days every twenty
seconds would burn the machine re-deriving rows that cannot have moved.

**Both `hub serve` and the launchd daemon collect, and a lease keeps them from
doing it twice.** The server keeps the page fresh while it is open; the daemon
(`hub collect --watch`, installed by `hub/bin/install-launchd.sh`) keeps it
fresh when it is not. An in-process flag cannot see another process, so the
lease is a row in `setting`, acquired by a single conditional UPDATE that
SQLite settles atomically. This is not fussiness: the transcripts leg CLEARS a
session's spans before reinserting them, so two interleaved collectors can have
one delete rows the other is midway through writing.

Whoever holds it renews each cycle; the other waits. A holder that exits
cleanly **hands the lease back**, so takeover is about two seconds — without
that it waited out the full sixty-second timeout, which is a minute of stale
page for no reason. A holder that CRASHES still relies on expiry, which is why
the timeout exists at all.

The refresh button bypasses the lease deliberately: a person asking for it now
should not wait on another process's schedule.

## Bottega has a tracker now

The other four projects had one and this did not, so every hour spent building
this tooling landed in the untracked bucket - the largest single row on the
page, and precisely the spend that most needed a name.

It is a table and four verbs, not a service. The point is that a `DEV-N` key
exists to attach work to; everything downstream already knows what to do with
one, because nothing about the worktree rule, the commit rule or the in-flight
filter is specific to a tracker being remote.

**The history was backfilled by clustering the commits, and the clustering was
checked rather than trusted.** qwen-local returned well-formed JSON that was
wrong three ways against the 86-commit input: 11 shas missing, 17 assigned to
two tasks, and 2 shas that do not exist in the repo. codex returned an exact
partition. Both were validated programmatically against `git log` - which is
the only reason the difference was visible at all, and why `hub task import`
reads a reviewed file rather than writing an agent's answer straight through.

**A backfilled commit carries its REAL instant**, read from git, not the task's
date. Every other row in `commit_key` holds a full ISO timestamp, and
`2026-08-31` sorts BEFORE `2026-08-31T14:00:00Z` - so a date-only row falls
outside every window that contains its own day and matches nothing, silently.
With that fixed the backfill halved bottega's untracked time, 9h34m to 4h43m.
(It was called `devbox` then; the tracker keys and the history are unchanged.)

## The daily report

`hub send` gathers the window, asks one delegated call for a sentence per task,
renders text and HTML, and delivers over SMTP. `hub/bin/install-launchd.sh`
schedules it at 18:00 beside the collector.

**The report is a projection, not a pipeline.** work-report reconstructed "what
was worked on" by clustering raw events on ticket keys and normalised titles -
about 880 lines of it. Here the tasks already exist, already carry their titles
from the trackers, and already carry engaged time and spend, so the report is a
filter and a sort. That is what made a 3,176-line Python concern collapse into
a few hundred lines of TypeScript.

**"Shipped" means closed IN THIS WINDOW**, not merely closed. Counting every
task that is currently done called 35 things "shipped today" when only a handful
had closed that day and the rest were finished long ago and merely touched. Two
sources, because neither is complete: an observed status transition is the only
thing hub saw for itself, but that history only begins when the tracker leg
does, so a tracker's own `updated_at` fills the gap where it reports one. Work
that is done but closed earlier goes under **also worked on** - it is neither
newly shipped nor in progress, and saying either would be false.

**The floor counts engaged time, not conversation time.** work-report's guard
counted only Claude's own message gaps, so a day of heavy delegation - or of
tracker and commit work - could fall under the bar and skip silently.

**Summaries go through `orch`.** work-report defaulted to `claude_cli`, which
spends exactly the allotment the orchestrator exists to protect, and which was
returning truncated JSON in its logs. Its own config named `orch` as preferred;
here it is the only mode. A summariser that returns nothing usable loses the
sentences, never the report: the titles are already true.

**Briefs carry what a title cannot.** A `brief` gives the summariser stakes it
could not infer - that a migration exists because the framework is end-of-life.
An `exclude` keeps matched work out of the email while it goes on being
measured everywhere else, which is how internal review work stays out of a
stakeholder's inbox without vanishing from the ratio.

**No secret is in hub.db.** The settings hold a REFERENCE
(`keychain:work-report-smtp`); the password stays in the login keychain, is read
at use time, and reaches curl through a config file on stdin so it never appears
in the process list. The page is only ever told whether it resolves. Checked
rather than asserted: the real value appears in neither the payload, the page,
nor the database.

**The email is shaped by the question a reader has**: how much happened, then
where, then what. A KPI row, a per-project line, then the work grouped under its
project - not one flat list sorted by a number nobody asked about.

**A project's hours are unioned within that project**, so its tasks add to more
than its total, AND the projects add to more than the headline. Both are the
same fact one level apart: work runs in parallel and the headline is the wall
clock it all happened in. The footnote says so, because 53h of projects under an
18h headline is the first thing a reader will query.

**The HTML declares its own charset.** The MIME part header already says utf-8,
but a client that ignores it renders every em dash as mojibake - which is
exactly what a preview did to "Product matching & resolution overhaul - epic".
Two declarations cost nothing; one missing one corrupts the reader's copy.

Tables and inline hex for layout, never flex, grid or a CSS variable: an email
client will not load a stylesheet and cannot be trusted with either.

**Longhand font properties, never the `font:` shorthand.** Outlook and several
mobile clients drop a shorthand whose family list contains spaces and commas,
and the whole declaration goes with it - weight included. That is how a
700-weight title arrived on iOS at the same weight as its own summary, undoing
the contrast work while looking perfect in every browser.

**Media queries are an enhancement, never the layout.** Every rule in the head
block narrows something that is already usable without it, so a client that
strips `<style>` still gets a readable email - which is the only safe way to use
CSS in mail. Two breakpoints, and both were found by measuring rather than
guessing: at 480px the project heading has to wrap under its own name instead of
mid-phrase, and at 380px the table's minimum width turned out to be set by its
COLUMN HEADERS - "ENGAGED" and "SHIPPED" at 9.5px with letter-spacing held the
card at 334px inside a 320px screen. The numbers were never the problem.

Checked at 320, 390 and 1200: zero horizontal overflow at each.

Delivery is `curl`, not a mailer library. This concern has no runtime
dependencies at all, and a daily email is not a good reason for its first.

## Commands

```
hub collect [--since ISO] [--only runs|transcripts|git|tasks]
hub collect --watch          collect on a clock; what launchd runs
hub tasks [--hours N]        what has been worked on, most recently active first
hub serve [--port 7778]      the dashboard (collects too, if the daemon is not)
hub send [--dry-run]         the daily report; --dry-run prints it instead
hub task new|start|done|list|import

hub/bin/install-launchd.sh   install or refresh the collector agent
```
