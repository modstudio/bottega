---
title: Fix the diff under review
stage: review
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - trunk
---
Know what changed before deciding what is wrong with it; a review of what you assumed changed is worth nothing. Review `{{branch}}` against `origin/{{trunk}}` after fetching it, and also report any uncommitted or unpushed work in the branch's worktree, because a lens reviews only committed branch content.

Record the files and behavior the diff changes, and what it does not touch but depends on: a change to a shared definition is a change to every caller that resolves through it.

This step is done when the recorded scope names the base commit, the head commit, the changed files, and those dependencies, or states that the branch has no changes against `origin/{{trunk}}`, in which case the review stops there.
