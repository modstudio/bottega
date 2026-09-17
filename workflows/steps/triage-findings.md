---
title: Triage every finding
floor:
  - human-ruling
job: null
autonomy: ask
needs: []
---
Give every finding an independent refutation pass before accepting it: re-read the cited line in context, run the claimed probe, or break the code and confirm that the relevant test fails. A finding that resists checking is unverified, not accepted.

Record every finding's disposition with `orch review triage`, and grade every lens with `orch judge`. Do not let a finding disappear through omission.

This step is done only when a human has ruled on every finding as accepted, modified, rejected, skipped, or unverified, every disposition is recorded, and every lens is graded.
