---
description: Conduct for dispatch, rulings, admission, and session close-out
always: true
---

# Session conduct

## Score dispatched work

Read and score every run you dispatched, and never score a run you did not read. Unscored work cannot improve routing, while a guessed verdict teaches it something false. Use `orch pending` to find your runs and `orch score` or `orch judge` to close them. An unscored run whose owner session has gone unseen past `UNJUDGED_OWNER_WINDOW_MS`, or that has no owner, is expired by `orch sweep` as evidence-excluded with no verdict, because nobody remains who read it; a verdict its owner records later lifts that exclusion.

## Arm the heartbeat

When you dispatch work that you will not collect immediately, run `orchestrator/hooks/orch-heartbeat.sh` under the harness monitor. It keeps completions, failures, and questions visible while attention is elsewhere.

## Stop at unanswered questions

Never continue or land a chain while its worker has an unanswered question, because resuming it would force a guess. Use `orch answer` before `orch continue`.

## Admit through a pull request

Run `bun run check` on the reviewed branch, then use `gh pr create` and merge on GitHub. The local gate proves the commit; the pull request admits it to trunk.

## Close out the session

Release terminal worktrees with `orch close-out`, prune landed run branches with `orch branches prune`, which sweep also runs, close landed tasks with `hub task`, and offer a resume brief through `orch doc`. A session with held trees, unscored runs, or unclosed landed tasks is paused rather than finished.
