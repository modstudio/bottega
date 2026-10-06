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

Grade every lens with `orch judge`, which records the lens's score and every finding's disposition together and completes the review. For a lens with findings it takes one `--finding N=<disposition>:<severity-or-category>` per finding, where the disposition is `accepted`, `modified`, `rejected`, or `skipped`; rejected findings carry a category and every other disposition carries a severity. Do not let a finding disappear through omission.

This step is done only when every finding has a recorded ruling as accepted, modified, rejected, or skipped, every disposition is recorded, and every lens is graded.
