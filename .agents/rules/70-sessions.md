---
description: Conduct for dispatch, rulings, admission, and session close-out
always: true
---

# Session conduct

## Score dispatched work

Read and score every run you dispatched, and never score a run you did not read. Unscored work cannot improve routing, while a guessed verdict teaches it something false. Use `bottega score pending` to find your runs and `bottega score` to close them. An unscored run whose owner session has gone unseen past `UNJUDGED_OWNER_WINDOW_MS`, or that has no owner, is expired by `bottega machine sweep` as evidence-excluded with no verdict, because nobody remains who read it; a verdict its owner records later lifts that exclusion.

## Arm the heartbeat

When you dispatch work that you will not collect immediately, run `orchestrator/hooks/orch-heartbeat.sh` under the harness monitor. It keeps completions, failures, and questions visible while attention is elsewhere.

## Stop at unanswered questions

Never continue or land a chain while its worker has an unanswered question, because resuming it would force a guess. Use `bottega question answer` before `bottega run continue`.

## Admit through a pull request

Run `bun run check` on the reviewed branch, open the pull request with `bottega pr create`, and land it with `bottega pr merge`. `bottega pr create` refuses while the change's review triage is incomplete and records the evidence it admitted on; an override requires the operator and is recorded. `bottega pr merge` repeats that review-admission check for the head commit and refuses when it does not hold. It also refuses until the head commit is proven: by every required check the project declares, or, where it declares none, by a passing gate recorded for that commit with the landing branch not moved past it. Where the project declares a merge queue, it enqueues the admitted head, waits for the queue to land it, and does not apply the landing-branch freshness refusal, because the queue tests each pull request on top of the current trunk. CI proves the commit; the merge queue admits it to trunk.

## Keep development on the landing branch when releasing

On a machine where Bottega is developed, the installed copy is the `main` checkout and stays on its registered landing branch. Run `bottega release check` before tagging, then cut a release by tagging the release commit and pushing the tag; never check out the tag in the development checkout. The pushed tag runs the same version check again before publishing. The version in `package.json` must match the tag. The per-user store migrates only forward, so a copy older than the store refuses to open it.

On any other machine, install a release in its own directory and update it by replacing that directory.

## Close out the session

Run `bottega session close-out` to release everything the session owns through its ordinary owner and prove that nothing remains. Dispose of unique unproved branches only through `bottega tree branch dispose`, which archives their work before recording the ruling. Close landed tasks with `bottega task` and offer a resume brief through `bottega doc`. A session with live runs, held resources, queued landings, incomplete reviews, unresolved process items, unscored runs, or unclosed landed tasks is paused rather than finished.
