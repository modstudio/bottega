---
title: Ship a task
arguments:
  - name: key
    required: true
    description: The task key.
  - name: branch
    required: true
    rebind: true
    description: The branch to ship.
  - name: worktree
    required: true
    rebind: true
    description: "The branch's worktree path."
  - name: depth
    required: false
    description: "The name of the last release rung to reach; omit it to reach every rung the operator's level allows."
modes:
  - slug: full
    title: Ship and promote
    default: true
    steps:
      - rebase-trunk
      - sequence: review
      - acceptance
      - sequence: sync
      - sequence: land
      - sequence: release
  - slug: merge
    title: Ship through merge
    steps:
      - rebase-trunk
      - sequence: review
      - acceptance
      - sequence: sync
      - sequence: land
---
Review, gate, merge, promote through the project's release rungs as far as the operator's level allows, and close the task once no release rung remains unreached. The `merge` mode stops after merge and leaves promotion and closing to the caller.
