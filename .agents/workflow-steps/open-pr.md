---
title: Open the pull request
stage: ship
floor:
  - command-exit
  - recorded-artifact
commandEvidence: pull-request
job: null
autonomy: ask
needs:
  - trunk
---
When the branch's change differs from what the completed review round read, for example after an inline fix or applied findings, and `bottega review tier` still reports that round's tier, record the read of the new tip with `bottega review read --sha <tip> --note "<what was read after the fix>"` in `{{worktree}}`; the pre-push review admission refuses the push until then. A project review record is written against the tip it was run at, so after the tip moves also rerun `bottega review project-record {{branch}} --cwd {{worktree}} --reason "<what changed since the recorded review>"` in `{{worktree}}`; it exits zero when the project declares no review record, and a project's own pre-push check may refuse the push until it runs. If the tier rose, complete the review round the new tier requires instead. Push `{{branch}}` from `{{worktree}}`, then open the pull request with `bottega pr create`; it sets the base to `{{trunk}}` itself and refuses `--base`. Its body states what changed, why it changed, and the successful gate command and result. After opening it, run `bottega gate check --enabled --project {{project}} --pr <link>`.

This step is done only with a successful `bottega pr create` exec recorded for this step, or the pull-request link whose head is `{{branch}}` and base is `{{trunk}}`.
