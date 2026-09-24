---
description: Rules for collection, attribution, reporting, and the hub web application
paths: ["hub/**"]
---

# Web application

The Vite and React application lives in `hub/web`. Route modules live in
`hub/web/src/routes`, and TanStack Router generates the route tree. Static paths resolve
from the built distribution; other non-tRPC paths return the application entry point so
direct navigation and hard refresh enter the client router.

Every screen reads through a procedure in `hub/src/trpc/routers`. Procedures call the
canonical hub operation rather than duplicating its query or write. A screen therefore
adds a route, a procedure over the canonical operation, and navigation without defining a
second data model in the browser.

The selected window, filters and navigation counts share the external store in
`hub/web/src/lib/window.ts`. Live-query polling pauses while redrawing would disrupt an
open control, and it reads only completed collection state because collection has its
own cadence and lease.

Serve the current worktree before checking a screen, then verify direct navigation and a
hard refresh against that server. Filtering happens before any cap, because capping first
can hide matching rows behind another project's traffic.

# Design system

Build screens from `hub/web/src/ui`, and leave no control wearing the browser's own
appearance. `ui/` imports nothing from the app, its layers are declared in
`architecture.ts`, and `hub/web/lint/layout-only-classname.grit` refuses appearance
classes passed to its components: change a component's look through a variant it owns and
pass it margin, size and placement only. Browser behavior, such as the dialog element,
the popover attribute and anchor positioning, is used beneath our own styling; no
component library is added, and a component's keyboard behavior follows its WAI-ARIA APG
pattern.

Presentation that knows no domain belongs in `ui/`, while a component that knows what a
project, run or tracker is belongs beside the screens using it. `ProjectName` renders a
name and a color; `ProjectMark` knows where a project's color comes from.

Color, type and measurement come from `hub/web/src/styles/tokens.css` through the
Tailwind bridge in `hub/web/src/styles/theme.css`: raw values, then the meanings the
`dark` class overrides, then shared measurements. Name a token; never write a color
literal or a default Tailwind palette class. Color that reports a status is selected by
`data-tone`, which derives that role's whole triad from one anchor. Check a new pair's
contrast in the browser against WCAG AA, and mix color in sRGB because mixing in OKLCH
rotates hue.

A meaning that differs between light and dark is defined in the token file, so no screen
carries a `dark:` color decision of its own. Color supplied by data is not a token: the
element receives its pair and the token file decides which one applies, as `data-project`
does.

Figures and page titles use the mono family, and everything else the sans family; both
are named by their token.

The responsive measure is a card's own container rather than the viewport, so a docked
panel collapses a toolbar on any screen. Every collection is a `TableCard` with the same
toolbar slots, which give up room by kind as the card narrows and fold into one band of
cells on a phone, where the page header's actions join them. Opening a docked panel
collapses the rail.

# Engaged time

Every source emits half-open spans. Engaged time is their union per task, never the sum of
agent durations. A session waiting on a delegated run remains engaged, while concurrent
runs occupy one stretch of wall time. Apply the idle cap to each adjacent message pair so
its real start can overlap a run.

The estate total is the union across tasks as well. Never sum per-task totals into estate
time, because parallel work would claim more wall time than elapsed.

# Time and spend

Time and spend are distinct measurements that share spans. Charge each message's spend to
the span containing its timestamp. A leg with one message emits a zero-length span so its
spend is retained without inventing duration. Token reconciliation must conserve the
source total.

Keep `claude_tokens`, each agent's `vendor_tokens`, and `vendor_cost_usd` separate in
storage and in every measurement that feeds a decision, because counts from different
vendors are not comparable. A screen may show one combined token figure only where it
sits beside the same figures per agent, so the reader sees what was added together; the
combined figure is a rough sense of volume and never routing, attribution or spend
evidence.

# Attribution

Use attribution evidence in this order: worktree path, commit subject, prompt text, the
recorded branch, the delegated run's full prompt, then the nearest directly attributed leg
of the same session. Exclude injected payloads, reject a key from a different project than
the working directory, and label a borrowed sibling attribution so it cannot be mistaken
for direct evidence.

Read the full prompt before inferring an attribution and cache immutable prompt files by
path. Seed sibling attribution only from direct evidence; never chain borrowed keys. A
wrong key is worse than no key, so `attribute()` returns no task rather than guessing.

Task attribution never changes the project roll-up, because project and task identity use
different evidence. Match live worktree naming shapes without assuming the key begins the
directory name or that separators have one case. Keep unattributed work visible per
project because it is the blind spot in every task denominator.

# Orchestrator boundary and schema

Hub reads orchestrator data through the `orch runs` CLI interface and never opens
`orch.db`. Concerns do not share a local store.

Opening `hub.db` never changes its schema. `hub migrate` is the only schema writer and
applies the ordered, checksummed journal in `hub/migrations`. Ordinary opens refuse stores
whose journal is behind or ahead, and write transactions refuse a schema version different
from the one the process opened. `SCHEMA_INVARIANT`, `CONNECTION_SCHEMA_INVARIANT`, and
`JOURNAL_WHEN_ORDER` name the enforced rules.

Migration backfills are idempotent, migration hashing covers DDL rather than backfill
content, and columns read by running processes expand before they contract. The baseline
is the canonical SQLite DDL; later migrations are explicit SQL.

# Collection

A collect never overwrites a good token reading with a worse one, because transcript data
may be irrecoverable. Git-derived columns may refresh from history. Git ingestion may
seed missing task rows and update their timestamps, but it never downgrades a tracker row
that knows its title and status. Transcript spans are keyed by file rather than session,
because sidechains can share a session identifier.

Collection uses separate configured cadences for local and remote work. The server and
daemon may both request collection, but exactly one process collects on a clock. A store
lease coordinates processes atomically, is renewed by its holder, is released on a clean
exit, and expires after a crashed holder. An explicit refresh waits for and acquires that
same lease, so exactly one process collects at a time.

# Tracker

Hub's tracker gives local work a task key consumed by the same attribution rules as remote
trackers. Imported commit groupings must be validated as an exact partition of the source
history before writing, and each mapping uses the commit's actual instant.

# Daily report

The daily report is a projection of canonical tasks, engaged time, and spend. It does not
reconstruct work by clustering raw events.

“Done” means moved to done inside the report window. A task completed earlier but touched in
the window belongs under also worked on. Determine closure from an observed status
transition, falling back to the tracker's update timestamp where observation history is
unavailable. The send floor measures engaged time rather than conversation gaps.

Summaries go through `orch`. An unusable summary removes optional sentences, never the
report, because task titles remain authoritative. A report brief supplies stakes absent
from a title; an exclusion removes matched work from the email without removing it from
measurement.

Secrets never enter `hub.db`. Settings store a keychain reference, resolution happens at
use time, and the dashboard exposes only whether it resolves. Pass the secret to delivery
through standard input so it does not appear in the process list.

Order the email by the reader's questions: overall activity, project activity, then work
grouped by project. Project hours are unioned within each project, and the headline is
unioned across projects; explain that parallelism because the displayed subtotals are not
additive.

HTML email declares its charset in the document as well as the MIME part. Use tables and
inline values for core layout; never use flex, grid, or CSS variables for it. Use longhand
font properties, and use media queries only as an enhancement to a readable base. Delivery
uses `curl`; reporting does not add a mailer runtime dependency.
