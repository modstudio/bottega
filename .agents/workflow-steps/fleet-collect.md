---
title: Collect and verify the evidence
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs: []
---
Follow sections 2 and 3 of `bottega doc show agent-fleet-cost-value-review --scope global`. Collect `bottega agent list`, `bottega agent stats`, and per-agent `bottega run list --json` exports for the review window, running large exports in the background.

For every subscription agent, sum its recorded cost per calendar month and compare each month with the confirmed fee. Record whether the cost column is an allocation of the fee, and compute the real cost per run as the fee divided by that month's runs. Never carry a subscription agent's per-run cost from `bottega agent stats` forward.

This step is done when the recorded artifact holds the commands run, the review window, the per-month check for each subscription agent, each metered agent's spend per day, and the per-month export for every month in the window, which the trend in the next step needs.
