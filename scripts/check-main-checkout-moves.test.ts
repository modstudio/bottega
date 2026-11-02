import { expect, test } from 'bun:test'
import { branchMoveCalls, mainCheckoutMoveViolations } from './check-main-checkout-moves.ts'

test('refuses branch-moving git calls outside the mover and named non-main call sites', () => {
  const findings = branchMoveCalls({
    'orchestrator/src/database/machine-update.ts':
      "function update() { git(['pull', '--ff-only', 'origin', branch], cwd) }",
    'orchestrator/src/recipe/tree-refresh.ts':
      "function fastForwardTree() { git(['merge', '--ff-only', commit], cwd) }",
    'orchestrator/src/run/run-resume-claim.ts':
      "function restoreResumeIfNeeded() { git(['reset', '--hard', tip], cwd) }",
    'orchestrator/src/release/release-required.ts':
      "function moveNonInstallationMainCheckout() { git(['merge', '--ff-only', remote], cwd) }",
    'hub/src/unsafe.ts': "function moveMainCheckout() { git(['pull'], cwd) }",
    'shared/unsafe.ts': "function moveMainCheckout() { git(['merge', '--ff-only'], cwd) }",
  })

  expect(mainCheckoutMoveViolations(findings)).toEqual([
    'hub/src/unsafe.ts:1: pull may move a registered main checkout; route it through orchestrator/src/database/machine-update.ts',
    'shared/unsafe.ts:1: merge --ff-only may move a registered main checkout; route it through orchestrator/src/database/machine-update.ts',
  ])
})

test('does not exempt another move merely because it shares an admitted file', () => {
  const findings = branchMoveCalls({
    'orchestrator/src/recipe/tree-refresh.ts':
      "function refreshMainCheckout() { git(['merge', '--ff-only', commit], cwd) }",
  })

  expect(mainCheckoutMoveViolations(findings)).toEqual([
    'orchestrator/src/recipe/tree-refresh.ts:1: merge --ff-only may move a registered main checkout; route it through orchestrator/src/database/machine-update.ts',
  ])
})
