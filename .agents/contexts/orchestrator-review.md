---
description: Review lenses, calibration, tiers, the drain loop, filing, and what to delegate.
paths:
  - orchestrator/src/**/review*.ts
  - orchestrator/src/**/lens*.ts
  - orchestrator/src/**/issue.ts
  - orchestrator/src/**/issue-report-fields.ts
  - orchestrator/src/**/contract.ts
---

# Review lenses and reviewer calibration

A lens is a sealed core with one global identity. It is one narrow, named viewpoint applied independently to the artifact. It owns one question, explicitly excludes questions owned by other lenses, reads the actual diff and checkout rather than the builder's conclusion, loads canon from its authoritative source, and returns evidence-bearing findings under the fixed review schema. Review work is read-only. Synthesis happens after the lenses, and evaluation is a separate act that re-derives each finding.

Its variable payload is a named, versioned profile selected per axis by the project. Profiles belong to nobody: two projects selecting one profile share one row. A profile is selected, never inherited, overlaid or merged; when no selection exists the axis uses its profile named `default`. Content follows the selected profile. Reviewer precision follows the stable core identity, so a profile change does not fracture calibration evidence.

Every findings-producing job requires `--lens` with a stable id. This applies to `review-lens`, `review-lens-inline`, `safety`, and `craft`. `verify-claim` is not a lens: it answers one claim with true, false, or undecidable, so it keeps its answer contract and does not enter reviewer calibration.

The review schema requires severity, location, evidence, and proposed correction for every finding. It also requires machine-readable provenance: standards read, effective model, files covered, commands run, and what could not be verified. Orch measures the reviewed tree at dispatch; an agent's optional claim about the tree is not consulted for coverage. An empty findings array is a completed clean review only with provenance showing what was read, including a covered file from the measured change when its changed paths can be established. Without that coverage the run is an `unevidenced` failure of the agent, not a clean result; missing or malformed output is not a review.

A review is pinned to the change it read: its stable patch id and touched path set, with the reviewed tree retained as a secondary fact. A rebase over disjoint trunk work that preserves that patch keeps the review, as does a commit-message-only amendment. Rework changes the patch and outdates the row; landing names each exact lens to re-run against the tip. Overlapping trunk work still requires review of the composition even when git replayed it cleanly.

A review that must execute — mutate code and watch a test or a rendered page go red against a seeded database — declares it, through the lens's `requires_execution` or `--requires-execution` on the dispatch. Dispatch refuses such a review on a reader tree before it spends, because a reader has no database, containers or server. A reviewer never execs into another tree's containers or stack: that stack serves a different tree and passes against the wrong code. A run its tree kept from executing is scored with `--blocked-by-tree`, which removes it from routing evidence instead of marking the agent down.

A measurement job — diagnose, understand, file-question — returns what it measured or says why not. The caller names the tables at dispatch; each is delivered, blocked with a reason, or not applicable. A conclusion without its table is unevidenced, the same class as a clean review with no coverage.

Reviews are recorded when they happen and begin incomplete. Triage is a later act by the architect: each finding becomes accepted, modified, rejected, or skipped, and a review may be completed only after every finding is triaged. Thus an untriaged review remains visible rather than becoming indistinguishable from one that never ran.

A findings run records that incomplete review itself when its parsed reply terminalises. `orch judge` is the close-out verb: it records the score, review grades, finding triage, review completion and any pair verdict together. A pair means the same task: root runs with the same job and identical caller-prompt hash, and for findings work the same lens; their input trees must also match when both runs recorded one.

**Evidence identity is one tuple:** the caller prompt (`spec_sha`), the change (stable patch-id plus touched path set), the lens, and the effective model. Gates, pair offers, voids, reminders and routing each consume the dimensions relevant to their question from that tuple; none substitutes bound-prompt hash, tree identity, agent name or row status for one of them.

Reviewer precision is hits over triaged, where hits are accepted plus modified and triaged is accepted plus modified plus rejected. Skipped findings do not enter either side. Precision is computed over the most recent `REVIEW_WINDOW` complete review runs and is null below `MIN_REVIEW_TRIAGED`, never zero merely because evidence is absent. The three most frequent rejection categories travel with it. Calibration keys on stable lens plus the agent orch actually selected and records the effective model. A model-specific cell is preferred once it meets the floor; otherwise it falls back to the lens-agent aggregate, and remains null when that is below the floor too. The source projects' reviewer tiers do not transfer: orch routes external agent harnesses and records the exact effective model, which is the evidence key here.

Orch appends the calibration line only after routing, because only then is the selected agent known, and before hashing and storing the bound prompt so the line sent remains auditable. Routing reserves space for that suffix when it tests argv prompt limits.

Precision measures false positives among findings raised. It says nothing about defects the lens missed: recall requires seeded defects or escaped-defect attribution and is not claimed here.

# A fan-out cannot be synchronous

`orch do` detaches so concurrent review can run.

Review breadth follows a tier computed as the higher of risk and cognitive size (`review-tier.ts:classifyReviewTier`). Risk comes from the surface touched, never from line count. Tier `0` means the architect reads the diff and runs no lens; until tier-`0` recording has its own mechanism, land it as unreviewed with a reason. Bottega's mapping from change shape and tier to lenses is its `review` register setting, read with `orch review tier`.

The round ceiling and when to re-lens are always-on canon in `.agents/rules/20-build-and-buy.md`. Small and formatting findings are fixed inline in the same round, without re-review. Speculation is dropped in triage as `below-bar`; file it only when it is high or critical, or observed in a real run.

Move the tier boundaries from the per-tier calibration as evidence accumulates.

# A drain loop

## Start

A drain loop starts from a `hub task list` snapshot. The sessions working it split that board by cluster, give every task one owner, and send the split; ownership assumed rather than announced produced collisions. Dispatch stays within the lens and local-gate capacity available to drain it. Read every branch's tier from `orch review tier` before dispatching any lens, because the tier sets the review budget rather than ratifying it afterwards.

## Filing

A finding becomes a task only when it blocks admission or was observed in a real run that cost real time. Fix anything smaller inline on the branch that surfaced it, or reject it in triage as `below-bar` and put the reason on the review row; filing every observation is a loop that cannot end. A mechanism gap seen once belongs as a comment on the nearest existing task. Seen twice with cost, it has earned a task.

Inline is the default for anything smaller than a task, and it applies to what a session finds while working, not only to review findings. An issue that fits in one commit the architect can read quickly is fixed on the branch at hand, or on a fresh branch cut at trunk and submitted the same hour at tier `0` or `1`, with no task; the commit or task note names what was fixed and why. The gate still runs. Two limits: an inline fix never touches a path under a freeze, and an inline fix that grows past one readable commit was a task all along — stop and file it.

## Tripped

When an agent or gate trips — a harness refusal, lockout, dead resume, or unrelated gate failure — ask one bounded question, answered quickly and not studied: **has this class tripped before, or did two checks collide?** If no, patch it now: one worker, one round, the violated invariant named in the spec, no task, then move on. If yes, step back: name the mechanism and the broken or missing invariant, then fix the class at the core once under one task. Every further instance is a comment on that task, never a task or patch: a trip files zero tasks or one, never a chain. Record the decision and one-line reason on the nearest task before dispatch. Answer from the record, not memory: `orch search` reads score notes, rulings, review findings, and saved outputs; run it and the task duplicate search on the trip's one-line description, then read what past tasks established before deciding. A hit is the class task: comment there and decide whether to patch or step back from its record, not by re-deriving it. One patch of a mechanism is allowed; a second aimed at it is the signal to step back.

## Review

The project's review declaration decides the applicable lenses, and the always-on review budget governs rounds. Read every lens of a tier-`3` round before writing their single fix round, because acting on half the review defeats the pair.

## Admission

Run the local gate on the reviewed branch, push it, and open a GitHub pull request. GitHub is the admission queue and squash-merge folds checkpoint commits. Merge conflicts, including migration-journal collisions, are resolved in the branch and gated again. Merge on GitHub; afterwards the main checkout pulls the landing branch and runs migrations. Carry a still-valid review pin rather than re-lensing it. Rebase a branch that has fallen behind trunk in the same breath as its resume or lens dispatch; the harness refuses a stale caller. A red gate is a real finding: fix it or report it, without a retry path that can turn the same failure green.

## End

The loop ends when the board is empty or every task left is held by a named operator ruling recorded on that task, or owned by another session's announced sequence. Follow the orch-status skill `CLOSE OUT` section: discard each landed run's worktree, remove its branch, close every landed task still open, and offer a resume brief. A session with unscored runs, unclosed landed tasks, or held worktrees has paused; it has not ended. The Stop hook closes out every terminal tree owned by the session: clean trees and their provisioned resources are released while branches survive; dirty trees and explicit `--keep-tree` holds are named with their resolving command.

# You file it, you fix it

Filing a task is not a way to put work down. A session that discovers a defect while doing other work fixes it or delegates the fix in that same session; filing alone is reserved for work that is genuinely blocked or genuinely someone else's. A filed-and-unfixed defect is indistinguishable from a fixed one on the board.

# Delegate what is specifiable

The line is not "the architect designs, agents implement". It is **whether a spec exists yet**. If the work can be written down well enough that a worker could build it faithfully, delegate it. If the requirement is still forming in conversation with the person asking for it, keep it.

**Iterative work with the user does not go to an agent**, and front-end work is the clearest case. The user reacts to what they see, the next requirement comes out of that reaction, and each turn is small. Routing that through a worker adds minutes to a loop that should take seconds, loses the shared context of the thing both parties just looked at, and asks an agent to guess at taste — the one thing a spec cannot carry. The same applies to debugging while somebody watches, to tuning wording or layout, and to anything where the answer to "is this right?" is a person looking at it.

Every argument for delegating rests on a spec the worker can be faithful to. Where there is no settled spec, none of that machinery has anything to grip. **Delegation is for work that has stopped moving.** Iterate until it settles, then delegate the next bounded chunk.
