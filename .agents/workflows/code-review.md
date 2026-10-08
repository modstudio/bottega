---
title: Review code
arguments:
  - name: key
    required: true
    description: The task key the review is attributed to.
  - name: branch
    required: true
    description: The branch to review.
  - name: worktree
    required: true
    rebind: true
    description: "The branch's worktree path."
modes:
  - slug: report
    title: Report findings
    default: true
    steps:
      - in-review
      - scope
      - review-lenses
      - triage-findings
      - report-review
  - slug: apply
    title: Apply accepted findings
    steps:
      - in-review
      - scope
      - sequence: review
      - run-gate
---
Review a branch with independent lenses sized by its review tier, refute every finding before accepting it, and either report the triaged review without changing anything or apply the accepted findings and gate the result.
