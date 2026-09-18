---
title: Report an issue
arguments:
  - name: report
    required: true
    description: The raw report text or the location where it can be read.
modes:
  - slug: person
    title: Report from a person
    default: true
    steps:
      - restate-report
      - dedupe
      - confirm-restatement
      - file-report
  - slug: agent
    title: Report from an agent
    steps:
      - restate-report
      - dedupe
      - file-report
---
Turn a raw report into a grounded, deduplicated issue in the composing project's tracker. A person confirms the filed restatement before creation; an agent proceeds without that confirmation.
