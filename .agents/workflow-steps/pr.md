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
Push the branch with `git -C {{worktree}} push -u origin {{branch}}`, then open a pull request with `gh pr create --base {{trunk}} --head {{branch}} --title "{{key}} <summary>" --body-file <file>`; the body states what changed, why, and the gate result. After opening it, run `orch check --enabled --project {{project}} --pr <link>`. This step is done only when that check exits zero.
