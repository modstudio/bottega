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
From the main checkout's `bottega`, run `bottega review tier {{branch}}` and dispatch exactly the lenses it lists, one run per lens. After a completed round it applies the post-fix rule: when it reports that no round is needed, dispatch none, because the architect reads the fix and lands it; when it reports tier-3 paths touched, it lists only the lenses that fix touched; when it reports that the reviewed tip could not be identified, dispatch the full list it falls back to. A lens already recorded on this branch tip, such as the blast-radius lens a defect fix has already run, satisfies that listed lens, so dispatch only the lenses still needed and never run the same lens twice on the same tip. A second opinion listed by `bottega review tier` is the one exception: run it after the first opinion of that lens, pass `--distinct-from <first-run>` naming that run, and count both results toward the review. At tier zero dispatch none.

Dispatch each lens with `bottega run start review-lens --review {{branch}} --key {{key}} --lens <id> "Review {{key}}: the change on {{branch}} against its task."`. When `facts.tracker.protocol` is `workspace-mcp`, add `--mcp` and require the lens prompt to read the task with `{{tracker.actions.get}}` and every linked task document through the MCP server named by `facts.tracker.server` in the composition. Never exceed the tier's review-round ceiling. When the ceiling is reached, stop and ask the operator instead of starting another round.

This step is done only when the review holds one recorded result for every dispatched lens, including an explicit no-findings result when a lens found nothing.
