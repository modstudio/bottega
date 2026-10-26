---
title: Size local hardware
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs: []
---
Follow section 6 of `bottega doc show agent-fleet-cost-value-review --scope global`. Name the open-weight models that score well here and their weight sizes, compute peak concurrent runs from the run export, and size memory, speed and price tiers from current cited listings. Compute break-even against measured metered spend at today's volume and at the operator's target, including electricity, and again with hosted spend falling at the measured and cited price trends over the hardware's working life, and run `bottega machine monitor` in the background to see whether this host is the real limit.

This step is done when the recorded artifact holds the tier table, the break-even, the bottleneck finding, and the rental trial that would settle the purchase.
