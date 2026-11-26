---
description: Conduct for dispatch, rulings, admission, and session close-out
always: true
---

# Session conduct

## Score dispatched work

Read and score every run you dispatched; never score one you did not read. Unscored work cannot improve routing, while a guessed verdict teaches it something false. Use `bottega score pending` to find them and `bottega score` to close them. `bottega machine sweep` expires an unscored run with no owner or one unseen past `UNJUDGED_OWNER_WINDOW_MS` as evidence-excluded because nobody remains who read it; a later owner verdict lifts that exclusion.

## Arm the heartbeat

When you dispatch work that you will not collect immediately, run `orchestrator/hooks/orch-heartbeat.sh` under the harness monitor. It keeps completions, failures, and questions visible while attention is elsewhere.

## Stop at unanswered questions

Never continue or land a chain while its worker has an unanswered question, because resuming it would force a guess. Use `bottega question answer` before `bottega run continue`.

## Keep context current while working

Record facts and pointers when they are learned. Revise or drop context items when they stop being true. Session context holds live state only.

## Admit through a pull request

Run `bun run check` on the reviewed branch, open the pull request with `bottega pr create`, and land it with `bottega pr merge`. Both refuse until review admission holds for the head commit; an override requires the user and is recorded. Merge also refuses until that commit is proven by every required check the project declares, or by a recorded passing gate where it declares none. Where the project declares a merge queue, merge enqueues the admitted head and waits for it to land: CI proves the commit; the merge queue admits it to trunk.

## Keep development on the landing branch when releasing

Keep Bottega's installed copy on `main`. Run `bottega release check`, then tag and push; never check out the tag there. The pushed tag reruns the check before publishing. `package.json` must match the tag. Because the per-user store migrates only forward, an older copy refuses it.

The tag publish refuses until each hosted rung is live for the tag; regenerate the tracked rungs file with `bottega release rungs --write`.

Elsewhere, install a release in its own directory and update it by replacing the directory.

Deploy images run `RELEASE_BUN_VERSION`; `scripts/check-bun-versions.ts` enforces it.

## Close out the session

Run `bottega session close-out` to release everything the session owns through its ordinary owner and prove that nothing remains. Dispose of unique unproved branches only through `bottega tree branch dispose`, which archives their work before recording the ruling. Close landed tasks with `bottega task` and offer a resume brief through `bottega doc`. A session with live runs, held resources, queued landings, incomplete reviews, unresolved process items, unscored runs, or unclosed landed tasks is paused, not finished.
