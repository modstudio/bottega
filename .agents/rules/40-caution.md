---
description: Reversible cleanup, conservative destructive defaults, liveness, claims, and visible escalation
always: true
---

# Reasonable caution with measurement

Take reasonable caution, then measure what escapes it. Do not try to anticipate
every case. This governs provisioning, teardown, permissions and every other
place an agent decides what it may do.

## Provision and release on the ordinary path

The task that provisions a resource tears it down. Standing up and tearing down
are paired ordinary steps, without ceremony or a separate request. Release
everything the normal path can release; only residue a stopped process cannot
release needs a conversation.

Fixtures obey the same provisioning and release rule.

Do not retain a resource because it might be useful later. Name what would be
lost and where another copy exists. Reprovisionable databases and work already
committed to a branch are recoverable; uncommitted work, an unpushed branch and
production data may be unique and earn protection.

Calibrate caution to realistic stakes. Local recoverable state does not merit
the process cost appropriate to irreversible production loss.

## Unknown destructive cases stop visibly

When the safety of a destructive case cannot be established, do nothing,
record the unmet condition where someone will see it and escalate. Do not add a
new special case. A conservative default without a visible record is merely
silent inaction.

The conservative default governs destruction, not reclamation. Ask whether the
operation can be undone by doing it again. Removing a rebuildable resource is
reversible and belongs on the ordinary path; removing the last copy is
destructive and requires the conservative default and escalation. The verb
“teardown” does not decide this question.

## Every verb declares its question

Each verb states the exact question its predicate answers. Never share a helper
that ambiguously reports who is present.

“Is anyone alive on this resource?” considers actual liveness. A participant
blocked waiting for a ruling is alive; a finished participant is not.

“Does anyone still claim this resource?” considers every recorded pointer
regardless of state. Clear claims instead of orphaning them.

These are examples of the governing rule, not an exhaustive lookup table. A
new caller names and answers its own question.

## Refuse defects when they are written

A check that can judge a file when it is written runs there as a hook and
refuses the edit. Refusing an edit costs far less than finding the defect at
the gate or in review. The hook and the gate run the same check; the gate is
the backstop.

A write-time check that cannot judge allows the edit and says so. Failure of
the write-time check itself never blocks the edit.
