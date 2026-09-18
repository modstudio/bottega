---
title: Write the task
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - tracker
---
After the plan is approved, create or update the task in this project's {{tracker.kind}} tracker through {{tracker.protocol}} with `{{tracker.actions.create}}` or `{{tracker.actions.update}}`, then read it back with `{{tracker.actions.get}}`. Write it so a worker can pick it up cold: a concise outcome, relevant current-state context, explicit boundaries, verifiable acceptance criteria, dependencies, and the approved decisions that constrain implementation. Preserve the key returned by the tracker rather than guessing it.

Keep the plan in the tracker description when it fits. Create task documents only when the tracker description cannot carry the work clearly, and only for material such as lengthy requirements, an order-dependent plan, or durable design decisions.

This step is done when the tracker returns the created or updated task and a read-back confirms that its key and recorded text match the approved plan.
