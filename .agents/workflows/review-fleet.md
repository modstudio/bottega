---
title: Review the agent fleet
arguments: []
modes:
  - slug: agents
    title: Agents only
    default: true
    steps:
      - fleet-confirm-inputs
      - fleet-collect
      - fleet-value
      - fleet-candidates
      - fleet-report
      - fleet-apply-rulings
  - slug: full
    title: Agents and hardware
    steps:
      - fleet-confirm-inputs
      - fleet-collect
      - fleet-value
      - fleet-candidates
      - fleet-hardware
      - fleet-report
      - fleet-apply-rulings
---
Evaluate subscription and OpenRouter agents on cost versus value, trial new models, and optionally size local hardware to replace the workers. The operator confirms subscription costs before any arithmetic and rules on every change to an agent row.
