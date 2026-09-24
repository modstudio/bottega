---
name: orch-status
description: Answer "status?" for the current session working the bottega board. Correlates board tasks, session-owned orch runs, open rulings, scoring debt, landing commits, and close-out work without reading either database directly.
---

# Report This Session's Status

This skill answers one question: what this session finished, what is moving,
what is stuck, what remains unstarted, and what only the architect can do next.
It composes the board, run, inbox, pending, and git interfaces; it does not read
either database and it does not substitute confidence for a fact an interface
does not publish.

The default scope is the current session. `--all` changes COMPLETE, IN PROGRESS,
and NEEDS ME to the whole machine and adds a session column everywhere those
sections show work. QUEUED is always board-wide because an unstarted task has no
run and therefore no session. Accept no other argument.

## Read the sources

Run each command once. Do not poll, start a background process, or leave a
process behind.

1. Read the board with `./bin/hub task list --project bottega --json`. Parse the
   response as one JSON array. Its `parent_key` fields establish task hierarchy;
   `opened_at` is not a filing-session identifier or a `created_at` field.
2. Read run chains as JSON Lines with
   `./bin/orch runs --json --limit 100000`. Parse each nonblank line as one JSON
   object; the stream is not one JSON document.
3. Read scoring debt with `./bin/orch pending`.
4. Read rulings with `./bin/orch inbox --json` for the default report, or
   `./bin/orch inbox --all --json` for `--all`.
5. For every in-scope task, query trunk separately with a bounded
   `git log main -1 --format='%H%x09%s' --extended-regexp
   --grep='(^|[^[:alnum:]-])<KEY>([^[:digit:]]|$)'`. A board status is not
   evidence that work landed.

The fixed run limit bounds the command without silently turning a recent window
into all history. If it returns 100000 rows, say that the run interface reached
its cap and do not classify any task as QUEUED: the missing older rows could
prove that a task started. Git queries use `-1` because the newest matching
trunk commit is the landing evidence this report needs.

Capture each command's exit status, stdout, and stderr. An empty response is not
an empty category. If a command fails, prints no usable data, or returns data
that cannot be parsed, name that interface and its result in the affected
section and do not make the claim it would have established. `orch pending`
normally exits 1 when it finds work; that documented exit is data, not a command
failure. Preserve its listed run IDs rather than recreating its scoring rule.
An explicit empty collection such as `[]` is usable data, but keep its provenance
visible in the report: say `orch inbox returned no entries`, for example, rather
than letting a blank field read as an independently established absence.

## Establish scope and task identity

For the default report, read the current session identifier from
`CLAUDE_CODE_SESSION_ID`, falling back to `CLAUDE_CODE_BRIDGE_SESSION_ID` in the
same order as orch. If neither exists, refuse to produce a session report and
say that current-session ownership is unavailable. Do not guess it from the
working directory, branch, newest run, or another session's activity.

Filter run chains by exact `run.session_id` equality before attributing any work
to this session. Under `--all`, retain every session and print the exact session
ID; render a null ID as `unattributed`, never as the current session.

Associate runs with tasks by extracting every exact `DEV-[0-9]+` token from
both `branch` and `prompt_head`. De-duplicate keys within a chain. Do not infer a
task from prose, adjacency, a worktree number, or a branch belonging to another
run. A task may have several runs or branches, and one run may name several
tasks; retain all of those facts. Ignore keys that are not on the bottega board
and say how many such keys were ignored.

The root run ID identifies a chain. A chain is live when any object in its
`turns` array has `status` equal to `running`, regardless of the root's or latest
turn's status. Report the root ID, but compute elapsed time from the
`started_at` of the currently running turn. If malformed data presents more
than one running turn, show each rather than choosing one.

Correlate inbox entries to chains by `answer_id`, which is the canonical root
ID. In the default report, keep only entries whose matching root has this
session's ID; `orch inbox --json` may also surface an orphaned question from a
different session. Under `--all`, retain all entries and take the session from
the matching run, not from an inference about who can answer it.

## Classify the board

Build the five sections in this order.

### COMPLETE

A task belongs here only when all three facts hold:

- its board status is `done`;
- at least one in-scope run names its key; and
- the exact-key git query finds a commit on `main`.

Print the key, title, full landing commit hash, and subject. Under `--all`, also
print the session ID or IDs of the runs that associated the task with the
report. If several session IDs name one task, show all of them rather than
choosing an owner.

Inside COMPLETE, add a `CLAIMED DONE, NOT LANDED` subsection. Put every
in-scope task whose board status is `done` but whose exact-key git query finds
no trunk commit there. Say that the board claims `done` and the trunk has no
matching commit; never count it as complete. If git could not answer, report
verification unavailable instead of putting the task in either bucket.

### IN PROGRESS

Include every in-scope task named by a run that is not classified above and is
not `dropped`. This includes an `open` task once a run names it, as well as
tasks in `active` or `review`.

For each task print:

- key, title, and board status;
- session ID under `--all`;
- every distinct branch recorded by its in-scope runs, most recent first;
- every live chain root, its agent/job, and elapsed time from its current
  running turn;
- whether an inbox entry is waiting on that chain, including the question;
- any run IDs that `orch pending` says need scoring; and
- what is known to stand between the task and landing.

Use only observed blockers. A waiting question needs a ruling. A live chain is
still executing. A pending run needs the architect's score. A task in `review`
still needs its review/landing path completed, but do not claim the review's
recording or triage state. If a trunk commit already exists while the board is
still open, active, or review, say that landing is present and board closure is
outstanding.

When a task has no live chain and no inbox entry, label it `STALLED` explicitly,
even when it also has scoring debt or a review board status. Do not make the
reader infer stalled state from missing fields. If the run or inbox interface
was unavailable, say `stalled state unavailable` instead; absence of evidence
from a failed interface is not evidence of inactivity.

### QUEUED (board-wide; unstarted tasks have no session)

List every bottega task whose board status is `open` and whose key appears in no
run from any session. This section deliberately does not use the default session
filter. Print the key and title.

If the run interface failed, returned no usable data, or reached its row cap,
print that QUEUED cannot be established and why. Do not turn the board's open
rows into a queue without proving that no run names them.

### NEEDS ME

List only architect actions established by the published interfaces:

- every run reported by `orch pending`, with its scoring command;
- every in-scope inbox question, with its canonical root answer ID and question;
- any `CLAIMED DONE, NOT LANDED` task, requiring reconciliation of the board
  claim with trunk; and
- any in-progress task labeled `STALLED`, requiring a decision to resume,
  reassign, close, or otherwise act.

Under `--all`, keep the session ID beside every run, question, and stalled task.
Another session's work remains visibly another session's; never describe it as
this session's.

`orch pending` publishes scoring debt only for the calling session. Under
`--all`, print its results under that session and also print
`Machine-wide scoring debt is not reported: orch pending is session-scoped.`
Do not derive other sessions' scoring debt from null delivery or quality fields;
those fields are also null for work that never became judgeable.

End NEEDS ME with this literal line:

`Untriaged reviews and gate state are not reported: no published interface exposes them.`

That line is required even when every reported list is otherwise empty. These
facts cannot be inferred from delivery/quality scores, task status, branch
existence, or a green result mentioned in prose.

### CLOSE OUT

CLOSE OUT is a current-session checklist, including under `--all`; never turn
it into permission to clean up every session on the machine. Print the full
checklist only when this session's IN PROGRESS tasks have no live chain and its
NEEDS ME entries have no open inbox ruling. Otherwise print only
`Close-out is not applicable while work is live.` under the heading. Scoring
debt and stalled work do not suppress the checklist: they belong in its
OUTSTANDING lines.

Before the six groups, print an `UNLANDED WORK` line because it is the most
important close-out fact. Consider every existing local branch recorded by
this session's runs whose name exactly matches `<KEY>-orch-<root-id>`, with an
exact bottega task key and that run's root ID. Confirm each recorded branch
exists with `git show-ref --verify --quiet refs/heads/<branch>`; exit 1 means it
is no longer a local branch, while any other nonzero exit makes the fact
unavailable. For each existing branch run
`git merge-base --is-ancestor <branch> main`. Exit 0 proves all of its commits
are on trunk; exit 1 proves it has unlanded work, whose count comes from
`git rev-list --count main..<branch>`. Print every unlanded branch and
its commit count on that first line (or its continuation lines). Any other
exit, a missing repository, or an unusable count makes branch close-out
unavailable; report that result rather than classifying the branch.

Build the checklist from these six groups, in this order:

1. `WORKTREES` — use only the `cwd` or `worktree` path published for a run whose
   exact `session_id` is the current session. Never infer ownership from a
   directory listing. Keep paths under a `.claude/worktrees` directory whose
   chain has no running turn, whose path still resolves as a git worktree, and
   whose root ID is absent from the usable `orch pending` result. Print the
   path and `orch discard <root-id>`. A terminal run named by `orch pending`
   stays under NEEDS ME and OUTSTANDING and is never offered here. If the run
   stream does not publish a usable ownership path, say that worktree close-out
   cannot be established; do not scan the directory to reconstruct it.
2. `BRANCHES` — repeat each unlanded branch and its commit count, then for each
   matching branch whose ancestor check exited 0 print
   `git branch -d <branch>`. Do not offer deletion for an unlanded or
   unverified branch. A branch still checked out in a listed worktree may need
   its `orch discard` command run first; keep the commands in checklist order
   rather than claiming deletion has already become possible.
3. `TASKS — LANDED, NOT CLOSED` — list every task named by this session's runs
   whose exact-key trunk query found a commit while its board status is not
   `done`. Print the key, title, status, full commit hash, and subject. This is
   the inverse of COMPLETE's `CLAIMED DONE, NOT LANDED` check. If board or git
   could not answer, report that task close-out is unavailable instead of
   treating the list as empty.
4. `OUTSTANDING` — repeat every current-session run named by `orch pending`
   with its scoring command, and every current-session inbox question with its
   canonical root answer ID and question. End the group with this literal line:
   `Untriaged reviews and gate state are not reported: no published interface exposes them.`
5. `FOLLOW-UPS` — a filing time is only a heuristic, never session ownership.
   If the board publishes `created_at`, list open tasks whose `created_at` is
   at or after this session's earliest run `started_at`, and label every result
   `heuristic: created after session began`. The current `hub task list --json`
   interface publishes `opened_at`, not `created_at`, so say
   `Follow-ups cannot be established: hub does not publish a filing session or created_at.`
   Never substitute `opened_at`, task-number order, prompt text, or adjacency.
6. `HANDOFF` — recommend `/resume-brief` and
   `orch doc resumes --cwd "$PWD"` when the checklist established any unlanded
   work, any open follow-up, or an in-progress epic. An epic is established by
   board hierarchy: an in-scope IN PROGRESS task is an epic when another board
   row names it in `parent_key`; do not infer one from title wording. If none of
   the three conditions exists and every needed interface answered, say no
   handoff is needed because there is no unlanded work, open follow-up, or
   in-progress epic. If follow-ups or another needed fact could not be
   established, say handoff cannot be established and name the missing fact;
   never turn an unknown into `none needed`.

If any board, run, pending, inbox, or git interface needed by CLOSE OUT failed,
printed no usable data, reached its cap, or could not parse, begin the section
with `Close-out cannot be established:` and name every affected interface and
result. Print any independently established checklist facts that remain useful,
but never print `None established` for a group whose absence depends on an
unavailable interface.

## Present one honest output

Use the five headings exactly and keep COMPLETE's claimed-done subsection
inside COMPLETE so the report still has five top-level sections. Put the scope
beside the report title: the exact current session ID by default, or `all
sessions` for `--all`. QUEUED carries its board-wide scope in its heading.
CLOSE OUT retains current-session scope under `--all` and must label that scope
when the rest of the report says `all sessions`.

Within a section, `None established` is allowed only when every interface needed
for that section returned usable data and the classification found no rows. If
an interface returned nothing, failed, was truncated, or could not see its data,
print that condition instead. Never translate it to "nothing complete", "nothing
in progress", "nothing queued", or "nothing needs me".
