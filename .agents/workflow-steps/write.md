---
title: Write the task
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - tracker
  - workflow-text
---
After the plan is approved, carry every entry from `facts.workflowText` into the task, then create or update the task in this project's {{tracker.kind}} tracker through {{tracker.protocol}} with `{{tracker.actions.create}}` or `{{tracker.actions.update}}` and read it back with `{{tracker.actions.get}}`. A step closed on a run contributed no text to `facts.workflowText`; read that run's result and carry its conclusion into the task. Write it so a worker can pick it up cold: a concise outcome, relevant current-state context, explicit boundaries, verifiable acceptance criteria, dependencies, and the approved decisions that constrain implementation. Preserve the key returned by the tracker rather than guessing it. Task creation does not acknowledge attachment references.

Close this step with `--artifact task:<KEY>`, using the key the tracker returned.

An update replaces a description the task already has; the hub tracker requires `--force` for it. First copy into the new text anything the old description holds that the plan does not, such as a promoted note's text and its sightings.

Keep the plan in the tracker description when it fits. Create task documents only when the tracker description cannot carry the work clearly, and only for material such as lengthy requirements, an order-dependent plan, or durable design decisions.

This step is done when the tracker returns the created or updated task and a read-back confirms that its key and recorded text match the approved plan.
