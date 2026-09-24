---
title: Ship a task
arguments:
  - name: key
    required: true
    description: The task key.
  - name: branch
    required: true
    description: The branch to ship.
  - name: worktree
    required: true
    description: "The branch's worktree path."
  - name: depth
    required: false
    description: The name of the last release rung to reach; omit it to reach every rung.
modes:
  - slug: full
    title: Ship and promote
    default: true
    steps:
      - rebase-trunk
      - review-lenses
      - triage-findings
      - apply-findings
      - acceptance
      - run-gate
      - design-records
      - open-pr
      - merge-pr
      - promote-release
      - close-task
  - slug: merge
    title: Ship through merge
    steps:
      - rebase-trunk
      - review-lenses
      - triage-findings
      - apply-findings
      - acceptance
      - run-gate
      - design-records
      - open-pr
      - merge-pr
---
Review, gate, merge, promote through the project's release rungs, and close the task at the last rung reached. The `merge` mode stops after merge and leaves promotion and closing to the caller.
