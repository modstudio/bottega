---
title: Measure the defect class
stage: plan
floor:
  - class-measured
jobs: []
autonomy: auto
needs: []
---
Name the defect class, then run one re-runnable command that measures the whole class across the tree or record with `bottega workflow exec -- <command>`. The command prints the count as its last stdout line. A count of one is valid.

Close this step with `--artifact exec:<id> --class "<class name>"`.
