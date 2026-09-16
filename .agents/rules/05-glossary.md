---
description: Vocabulary shared by orchestration prompts and canon
always: true
---

# Glossary

**Run** — one bounded execution of a job by an agent, recorded for judgement.

**Chain** — the root run and its later turns; it inherits the last turn's state and the root carries the outcome.

**Turn** — a later row in the same conversation, created when a run is answered, retried, or continued.

**Job** — a named work shape that declares the capabilities and working set its agent needs.

**Pack** — the self-contained prompt material compiled for an agent from the applicable project and job canon.

**Lens** — one narrow, named review viewpoint with a stable identity, one question, and explicit exclusions.

**Review tier** — the review breadth and round budget selected from the higher of change risk and cognitive size.

**Fidelity** — the writing-job judgement of whether the delivered change built what the specification asked for.

**Escape** — an outside change that overlaps a run's own diff and therefore blocks that chain from landing.

**Worktree** — the disposable checkout that isolates a repository run and bounds what its agent may write.

**Recipe** — a registered project's own templates for provisioning and releasing a writing worktree.

**Claim** — any recorded pointer to a resource, regardless of whether its participant is alive.

**Record** — the hosted copy of execution evidence reached only through idempotent outbox synchronization.

**Note** — a one-line observation whose project, run, branch, session, commit, and file anchor are derived when filed.
