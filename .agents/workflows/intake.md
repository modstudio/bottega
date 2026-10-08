---
title: Take in signals
arguments:
  - name: scope
    required: false
    description: A source name or area to limit collection to.
modes:
  - slug: default
    title: Intake
    default: true
    steps:
      - collect
      - cohort
      - record
      - select
---
Turn a project's open signals into selected cohorts for planning. This workflow touches no code and ends when the operator has selected the cohorts to work.
