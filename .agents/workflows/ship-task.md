---
title: Land a built branch
arguments:
  - name: key
    required: true
    description: The task key.
  - name: branch
    required: true
    rebind: true
    description: The branch to ship.
  - name: worktree
    required: true
    rebind: true
    description: "The branch's worktree path."
  - name: depth
    required: false
    description: "The name of the last release rung to reach; omit it to reach every rung the operator's level allows."
modes:
  - slug: full
    title: Land and promote
    entry: "Does the branch go on past the merge through the project's release rungs?"
    steps:
      - rebase-trunk
      - scope
      - sequence: review
      - sequence: sync
        omit:
          - docs-gather
      - run-gate
      - acceptance
      - open-pr
      - waiting-for-review
      - step: judge-after-ci
        when:
          step: acceptance
          outcome:
            - owed
      - merge-pr
      - finish-ship-cleanup
      - step: judge-after-landing
        when:
          step: acceptance
          outcome:
            - owed
      - promote-release
      - step: judge-after-release
        when:
          step: acceptance
          outcome:
            - owed
      - close-task
  - slug: merge
    title: Land through merge
    entry: Does the branch stop at the merge into the landing branch?
    steps:
      - rebase-trunk
      - scope
      - sequence: review
      - sequence: sync
        omit:
          - docs-gather
      - run-gate
      - acceptance
      - open-pr
      - waiting-for-review
      - step: judge-after-ci
        when:
          step: acceptance
          outcome:
            - owed
      - merge-pr
      - finish-ship-cleanup
      - step: judge-after-landing
        when:
          step: acceptance
          outcome:
            - owed
---
Land a branch that already carries its change: rebase it, review it, run the gate, merge it by pull request, promote through the project's release rungs as far as the operator's level allows, and close the task once no release rung remains unreached. The implementation run builds the change; this workflow lands it. The `merge` mode stops after merge and leaves promotion and closing to the caller.
