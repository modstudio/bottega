---
title: Triage every finding
stage: review
floor:
  - ruling
job: null
autonomy: ask
needs:
  []
---
Give every finding an independent refutation pass before accepting it: re-read the cited line in context, run the claimed probe, or break the code and confirm that the relevant test fails. A finding that resists checking is unverified: record it as skipped with the reason, never as accepted.

Record every finding's disposition with `orch review triage`; it records the architect's per-finding disposition, category or severity, and reason on the review. For a lens with findings, `orch judge` takes one `--finding N=<disposition>:<severity-or-category>` per finding, where the disposition is `accepted`, `modified`, `rejected`, or `skipped`; rejected findings carry a category and every other disposition carries a severity. Grade every lens with `orch judge`. Do not let a finding disappear through omission.

This step is done only when every finding has a recorded ruling as accepted, modified, rejected, or skipped, every disposition is recorded, and every lens is graded.
