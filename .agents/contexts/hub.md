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

Use native browser controls and the existing small helpers. The selected window, filters,
and navigation counts share the external store in `hub/web/src/lib/window.ts`. Live-query
polling pauses while redrawing would disrupt an open control, and it reads only completed
collection state because collection has its own cadence and lease.

Serve the current worktree before checking a screen, then verify direct navigation and a
hard refresh against that server. Filtering happens before any cap, because capping first
can hide matching rows behind another project's traffic.

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

Keep `claude_tokens`, each agent's `vendor_tokens`, and `vendor_cost_usd` separate. Token
counts from different vendors are not comparable and must never become a combined total.

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

“Shipped” means closed inside the report window. A task completed earlier but touched in
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
