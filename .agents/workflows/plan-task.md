---
title: Plan a task
arguments:
  - name: key
    required: false
    description: The key of a task that already exists.
modes:
  - slug: feature
    title: Plan a feature
    entry: Does the work add or change user-visible behavior?
    steps:
      - dedupe
      - refresh
      - discover
      - research
      - design
      - decompose
      - signoff
      - write
      - start
  - slug: fix
    title: Plan a fix
    entry: Does the work correct behavior that can be reproduced?
    steps:
      - dedupe
      - refresh
      - discover
      - reproduce
      - research
      - recurrence
      - design
      - decompose
      - signoff
      - write
      - start
  - slug: requirements
    title: Record requirements
    entry: Should this request be clarified and recorded without technical design?
    steps:
      - dedupe
      - discover
      - write
---
Turn an intention into an approved, evidence-based task that another worker can pick up cold. Choose `feature` for new or changed behavior, `fix` for reproducible incorrect behavior, or `requirements` to record settled requirements without technical design. Whether the task already exists is carried separately by the optional key argument.
