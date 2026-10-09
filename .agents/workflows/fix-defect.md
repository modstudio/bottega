---
title: Fix a defect
defaultPreset: autonomous
arguments:
  - name: key
    required: false
    description: The filed task key.
  - name: branch
    required: false
    description: "The branch carrying the fix, known once implement-fix has created its worktree; needed from run-gate on."
  - name: worktree
    required: false
    rebind: true
    description: "The fix branch's worktree path, known once implement-fix has created it; needed from run-gate on."
  - name: signal
    required: false
    description: The production signal source or query from which a cohort is drawn.
  - name: window
    required: false
    description: "An observation window that overrides the project's registered release window."
modes:
  - slug: auto
    title: Triage and fix the most pressing defect
    entry: Should I triage what is open and fix the single most pressing defect?
    steps:
      - refresh
      - defect-pick
  - slug: single
    title: Fix one reported defect
    entry: Which filed task key should be fixed?
    requires:
      - key
    steps:
      - refresh
      - diagnose
      - reproduce
      - implement-fix
      - verify
      - blast-radius
      - sequence: review
      - sequence: sync
      - run-gate
      - sequence: land
      - sequence: release
  - slug: cohort
    title: Fix a root-cause cohort
    entry: "Which production signal should be grouped by root cause, and under which task key?"
    requires:
      - key
      - signal
    steps:
      - refresh
      - cohort-group
      - diagnose
      - reproduce
      - implement-fix
      - verify
      - blast-radius
      - sequence: review
      - sequence: sync
      - run-gate
      - sequence: land
      - promote-release
      - observe-release
      - close-task
---
Auto mode triages what is open and fixes the single most pressing defect. Single and cohort modes reproduce the reported failure, establish and implement its cause, verify the original condition, review the blast radius, pass the project gate, and ship the fix. Before merge, both modes prove the failure existed, the diagnosed fix removes it, and review findings and the project gate are resolved. Cohort mode additionally groups a required production signal by root cause before the fix and observes that signal for recurrence after promotion.
