---
title: Open the pull request
stage: ship
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: ask
needs:
  - trunk
---
Push the branch with `git -C {{worktree}} push -u origin {{branch}}`, then open a pull request with `gh pr create --base {{trunk}} --head {{branch}} --title "{{key}} <summary>" --body-file <file>`; the body states what changed, why, and the gate result.
