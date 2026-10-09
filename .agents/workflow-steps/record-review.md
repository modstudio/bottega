---
title: Record the finished review
stage: review
floor:
  - command-exit
job: null
autonomy: auto
needs:
  []
---
After accepted findings are applied, run `orch review project-record {{branch}} --cwd {{worktree}} --reason "<one line naming the lenses and what was accepted>"`. The project command records the review rounds against the branch tip as it now stands.

This step is done when the command exits zero, including when it reports that the project declares no review record.
