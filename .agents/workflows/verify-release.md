---
title: Verify an installed release
arguments:
  - name: key
    required: true
    description: The release smoke task key.
modes:
  - slug: default
    title: Verify release
    default: true
    steps:
      - release-provision
      - release-dispatch
      - release-verify
      - release-close
---
Prove that a freshly installed release can register a repository, create a task, dispatch a writing run on a workflow cursor, keep its shared ref guard outside the writing worktree, and retain the run's commit.
