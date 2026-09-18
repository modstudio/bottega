---
title: Fix a defect
arguments:
  - name: key
    required: true
    description: The filed task key.
  - name: branch
    required: true
    description: The branch carrying the fix.
  - name: worktree
    required: true
    description: "The fix branch's worktree path."
  - name: signal
    required: false
    description: The production signal source or query from which a cohort is drawn; required in cohort mode.
  - name: window
    required: false
    description: "An observation window that overrides the project's registered release window."
modes:
  - slug: single
    title: Fix one reported defect
    default: true
    steps:
      - refresh
      - diagnose
      - reproduce
      - implement-fix
      - verify
      - blast-radius
      - triage-findings
      - apply-findings
      - run-gate
      - open-pr
      - merge-pr
      - promote-release
      - close-task
  - slug: cohort
    title: Fix a root-cause cohort
    steps:
      - refresh
      - cohort-group
      - diagnose
      - reproduce
      - implement-fix
      - verify
      - blast-radius
      - triage-findings
      - apply-findings
      - run-gate
      - open-pr
      - merge-pr
      - promote-release
      - observe-release
      - close-task
---
Reproduce the reported failure, establish and implement its cause, verify the original condition, review the blast radius, pass the project gate, and ship the fix. Before merge, both modes prove the failure existed, the diagnosed fix removes it, and review findings and the project gate are resolved. Cohort mode additionally groups a required production signal by root cause before the fix and observes that signal for recurrence after promotion.
