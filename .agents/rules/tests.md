---
description: Test value, placement, isolation, runtime, and suite-budget rules
---

# Tests earn their standing cost

A test is paid for on every run forever. Keep one only when it can fail for a
subtle production defect and the defect's blast radius justifies that cost.

Reject vacuous assertions that cannot fail, change detectors that restate the
implementation, and over-isolated tests that never reach the real subject.
Assert observable effects rather than interactions.

Write tests where failure is silent and expensive. Skip them where the worst
case announces itself, and record that choice in the commit or task. Coverage
is a diagnostic rather than a target, and the type system needs no duplicate
test.

## Keep the gate cheap

Gate tests run in process, spawn nothing, build no repository and complete far
below the per-test timing budget. Pure decisions such as routing, evidence,
scoring, fidelity, canon injection and reply classification belong in the
gate. Runtime monitoring and close-out reports guard teardown, reclamation,
locks, reference guards, signals and exit codes.

No test uses the CLI subprocess shape, and there is no process-boundary test
package. `scripts/check-test-spawns.ts` enforces the spawn boundary.

## Keep tests beside their subject

A unit test is `<module>.test.ts` beside its module so both move and split
together. A concern's `test/` directory contains infrastructure only, such as
fixtures, preload, the gate runner and timing reporters. Do not create a
mirrored test tree. `scripts/check-test-placement.ts` enforces placement.

Test infrastructure may import production capabilities but must never
re-export them as another public surface. Mutate process environment only in a
test lifecycle hook and always restore it; never mutate it at module load.

Suite time is shared and `bun run check` reports the budget. Prefer deleting a
slow, low-value test to nursing it.

