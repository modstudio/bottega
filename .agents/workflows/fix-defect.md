---
title: Fix one reported defect
arguments:
  - name: key
    required: true
    description: The filed task key.
modes:
  - slug: default
    title: Resolve
    default: true
    steps:
      - diagnose
      - fix-defect-fix
      - verify
      - blast-radius
      - fix-defect-triage
      - ship
---
A projection of the 'orch fix-defect' command's coordinator for inspection.
