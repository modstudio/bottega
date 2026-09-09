---
name: cleanup
description: Answer "what resources are stranded, what can be returned now, and what needs the operator's decision?" by correlating the machine monitor, lifecycle, run, landing, and git worktree interfaces without reading either database directly.
---

# Walk Through Stranded Resources

This skill answers one question with the operator: which allocated resources no
longer serve work in flight, and what evidence permits each one to be returned.
It reports and previews first. It never treats discovery as permission to
remove anything.

Read **Reasonable caution, and a measure for what escapes it** in `AGENTS.md`
before starting. Its recoverability test governs every candidate: name what
would actually be lost and say where else it exists. Work committed to a branch
is in the branch. A database that can be provisioned again is not unique
evidence. Uncommitted work, an unpushed branch, and production data require the
operator's decision.

This skill asks two different questions and keeps their answers separate:

- **ALIVE — is anyone alive on this tree?** A `running` run is alive. A
  participant blocked waiting on an answer is also alive: `asking` is alive,
  not idle. This question protects work in flight.
- **CLAIMED — does any record still point at this resource?** Every recorded
  `cwd`, `worktree`, and branch pointer counts, whatever the run's state. This
  question governs destructive verbs.

One predicate must never answer both questions. Doing that makes the caller
inherit an answer to a question it never asked. Print both answers for every
worktree or branch considered for cleanup, including the evidence or interface
that established each answer.

## Read the sources

The observation question is: what stranded resources, lifecycle holds, live
work, recorded claims, and unavailable observations do the published
interfaces report?

Run these commands and capture each exit status, stdout, and stderr. Do not
poll, start a background process, or leave a process behind.

1. Run `./bin/orch monitor --json`. Parse its output as one JSON document.
   This is the Docker and process inventory interface; never invoke Docker
   directly. Exit 0 means the observation completed cleanly, exit 2 means it
   completed with conditions, and exit 1 means at least one observation was
   incomplete. Preserve every `condition`, every `error`, and the action text
   exactly.
2. Run `./bin/orch sweep --dry-run`. This command exists in this repository.
   Preserve every `would reclaim` row and every kept row with its printed
   reason. A nonzero exit may still carry useful rows, but it also makes the
   failed observation unknown; do not discard either fact.
3. Run `./bin/orch runs --json --limit 100000`. Parse each nonblank line as one
   JSON envelope and read the run from its `data` field. The stream is not one
   JSON document. Use every turn when answering ALIVE, and every root and turn
   pointer when answering CLAIMED. If exactly 100000 envelopes return, say the
   interface reached its cap and do not claim that an unmentioned resource has
   no run owner.
4. Run `./bin/orch land --status`. Landing queues, in-review branches, path
   sets, and locks are active lifecycle evidence, not cleanup candidates.
5. In the current repository run `git worktree list --porcelain`. Its question
   is only which git worktrees this repository currently registers. It does
   not establish run ownership or machine-wide absence. For worktrees in other
   registered projects, rely on the project-qualified paths and findings that
   orch publishes; do not discover repositories by scanning the filesystem.

Do not open `orch.db` or `hub.db`, import orchestrator query code, inspect the
Docker socket, or reconstruct a missing fact from a directory name. Correlate
resources by exact canonical path, exact run ID, exact branch, or exact Docker
resource name. Keep conflicting evidence visible rather than choosing the
answer that makes cleanup possible.

An empty response is not an empty category. Explicit empty JSON collections
and an empty but successful git worktree classification are usable evidence,
and their provenance remains visible. A failed command, malformed output,
truncated run stream, monitor `errors`, or observation-error condition belongs
in **COULD NOT VERIFY** for every classification that depended on it.

## Preview exact candidates

The preview question is: would the established cleanup guard accept this exact
resource now, without changing it?

For each exact worktree candidate, run
`./bin/orch reclaim worktree <path> --dry-run`. For each exact branch candidate,
run `./bin/orch reclaim branch <project>:<branch> --dry-run`. These previews are
additional published evidence; they do not replace the source pass above. Copy
their full refusal or success text into the report.

Never add `--force`. Never invent a removal command for a monitor condition
whose action says no established verb exists. A Docker resource is actionable
only through the exact orch lifecycle action published for it; never run
`docker rm`, `docker compose down`, or `docker volume rm` from this skill.

## Classify by disposition

Present these four headings in this order. Count resources, not duplicate
mentions of the same exact resource.

### SAFE TO RECLAIM NOW

Include a resource only when all required interfaces answered, the exact
preview permits reclaim, no run turn is `running` or `asking`, no landing state
uses it, and the recoverability test is explicit.

For every row print:

- the exact resource and the evidence that it is terminal;
- `ALIVE:` the exact evidence establishing that nobody is alive on it;
- `CLAIMED:` every recorded pointer, including terminal pointers, or the
  successful evidence establishing none;
- `WOULD LOSE:` what removal destroys;
- `RETAINED AT:` the branch, landing branch, remote, tag, or other exact place
  retaining the work, and which interface proved that; and
- `COMMAND:` one exact orch command for this resource.

A clean worktree may be returned while its committed work remains on its local
branch. That does not license deleting the branch. A recreatable worktree or
development database is an allocation, not unique evidence. State that
concretely for the row rather than merely calling it safe.

For branch deletion, a preview that relies only on a recorded
`branch_kept_tip` does not prove the branch was pushed or landed. If commits are
not proven reachable from another branch, remote, or tag, put the branch in
**NEEDS YOUR DECISION** as an unpushed branch even when the reclaim guard says
it could restore the recorded tip.

Print the count, then ask the operator which exact rows to reclaim. Do not run a
command yet.

### HELD FOR A REASON

Include resources kept by a lifecycle guard or interface: live or asking runs,
landing activity, scoring or explicit retention, dirty state, reachability
failure, an ownership rule, or another printed refusal. Quote the reason from
the reporting interface without weakening it. Print the exact command the
interface says clears the hold. If it publishes no clearing command, say so.

For each worktree or branch, still print separate `ALIVE:` and `CLAIMED:`
answers. A terminal claim remains a claim even though it is not live. Never
translate `too recent`, `unscored`, or a similar sweep reason into a stronger
claim than the command made.

### NEEDS YOUR DECISION

Include only decisions about unique or actively owned evidence:

- uncommitted work;
- an unpushed branch whose deletion is contemplated;
- production data; or
- a tree another live conversation still points at, including a participant
  waiting in `asking` state.

Name the exact decision and the evidence at stake. Do not recommend deletion
of unique evidence and do not turn the operator's request to inspect cleanup
into consent to resolve it. A live resource can appear here even when a
lifecycle guard also explains its hold; de-duplicate the resource and retain
both facts in its one row.

### COULD NOT VERIFY

This heading is mandatory. List each interface and exact observation it could
not complete, with exit status and stderr or parse failure, then name every
absence or safety claim that remains unestablished because of it. Monitor
observation errors belong here even when the same pass returned other usable
conditions.

Write `None; every required interface returned usable evidence` only when that
is true. Never turn unavailable Docker, process, run, landing, or git evidence
into an empty category, a zero count, or a clean-machine claim. If one
repository's worktree listing succeeded, do not let it imply that another
repository was inspected.

## Reclaim only after consent

The destructive question is: which exact commands has the operator authorized
in this invocation?

After presenting the report, wait for the operator to select exact rows or
exact commands. Consent to "clean up" starts this walkthrough; it is not
consent to execute the resulting commands. Do not treat silence, earlier
cleanup instructions, selection of one row, or approval of a category as
approval of any other row.

For selected worktrees, run the previously previewed
`./bin/orch reclaim worktree <path>` command. For selected branches, run the
previously previewed `./bin/orch reclaim branch <project>:<branch>` command.
Use an exact orch lifecycle command printed by `orch monitor` only when the
operator selects that exact command and resource. Never execute bare
`./bin/orch sweep`: its target set can change after the preview, so it is not
the exact consent the walkthrough obtained.

Before each destructive command, repeat the resource, `WOULD LOSE`,
`RETAINED AT`, and the exact command. Re-run its corresponding `--dry-run`
preview immediately before execution. If the evidence or result changed, stop
on that row, move it to the appropriate disposition, and ask again; old consent
does not cover a new state.

Execute selected commands one at a time. Report each command's actual result
before proceeding to the next. A refusal is a held resource, not permission to
bypass the guard. When finished, re-run only the observation needed to verify
the selected resource's result and report what remains. Do not start a second
machine-wide cleanup pass without a new operator request.
