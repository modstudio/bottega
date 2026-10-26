---
title: Scout and trial OpenRouter candidates
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs: []
---
Follow section 5 of `bottega doc show agent-fleet-cost-value-review --scope global`. Report the state of every candidate already on trial: runs scored, score, measured cost per run, and whether its blended price shows caching. Then scan the OpenRouter catalog for tool-capable models priced near the current metered leader, and estimate each one's cost per run with and without caching.

Register a promising candidate disabled and run its probe, as the doc describes. Switching a candidate on for routed work, or switching any agent off, waits for the operator's ruling in the final step.

This step is done when the recorded artifact lists each trial's evidence, each new candidate's estimate, and each probe result.
