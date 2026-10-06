---
title: Run independent review lenses
stage: review
floor:
  - recorded-artifact
job: review-lens
autonomy: auto
needs:
  - tracker
---
From the main checkout's `orch`, run `orch review tier {{branch}}`. For Bottega, `.agents/contexts/orchestrator-review.md` maps a change's shape to lenses. For another project, read the stack and project documents named by the composition and use that project's mapping there. Always include correctness. Choose the remaining lenses from the applicable mapping, dispatch exactly the tier's number of independent lenses, and at tier zero still dispatch one correctness lens.

Dispatch each lens with `orch do review-lens --review {{branch}} --key {{key}} --lens <id> "Review {{key}}: the change on {{branch}} against its task."`. When `facts.tracker.protocol` is `workspace-mcp`, add `--mcp` and require the lens prompt to read the task with `{{tracker.actions.get}}` and every linked task document through the registered `{{tracker.server}}` MCP server. Never exceed the tier's review-round ceiling. When the ceiling is reached, stop and ask the operator instead of starting another round.

This step is done only when the review holds one recorded result for every dispatched lens, including an explicit no-findings result when a lens found nothing.
