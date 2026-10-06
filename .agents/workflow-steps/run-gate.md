---
title: Run the project gate
stage: ship
floor:
  - command-exit
job: null
autonomy: auto
needs:
  - gate
  - release
---
Run `{{gate}}`, the project's registered local gate, in `{{worktree}}` in the foreground against the exact tree that will ship, then run the tests covering the change. When `facts.release.requiredChecks` names checks, the full suite belongs to CI and is confirmed at merge through those checks. When it names no checks, the registered gate is the only proof and must complete locally. Then, in `{{worktree}}`, run `orch check --enabled --project {{project}}`.

This step is done only when the registered gate, the tests covering the change, and the enabled project check exit zero. A skipped, backgrounded, partial, or unavailable gate or enabled project check does not complete it.
