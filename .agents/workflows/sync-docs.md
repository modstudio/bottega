---
title: Sync the docs
arguments:
  - name: key
    required: true
    description: The task whose change the documentation must follow.
  - name: worktree
    required: true
    description: "The change's worktree path."
  - name: scope
    required: false
    description: A path or area that limits the documentation sweep.
modes:
  - slug: default
    title: Sync documentation
    default: true
    steps:
      - docs-gather
      - docs-deviations
      - docs-apply
      - run-gate
---
Make the task documentation, canon, and knowledge base describe the change that was actually built. Find every deviation, require a human disposition for each one, apply the rulings through the project's registered adapters, and verify the result with the project gate.
