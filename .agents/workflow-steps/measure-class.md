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

The command runs relative to the tree it runs in and names no checkout or worktree by absolute path except its executable. The floor sees only the command's arguments, not paths inside a script file, so a script the command runs must itself use tree-relative paths.

Close this step with `--artifact exec:<id> --class "<class name>"`.
