import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  commandExitBindingRefusal,
  commandExitMismatchRefusal,
  gateFloorRefusal,
} from './workflow-floor-refusal.ts'

test('an unresolvable cursor worktree names its path and replacement argument', () => {
  const refusal = gateFloorRefusal({
    project: 'fixture',
    worktree: '/fixture/removed-tree',
    commit: null,
  })
  expect(refusal).toContain('recorded cursor worktree /fixture/removed-tree')
  expect(refusal).toContain('was removed')
  expect(refusal).toContain('--arg worktree=<tree>')
  expect(refusal).not.toContain('<current tree commit>')
})

test('a successful exec names the different expected exit check and both remedies', () => {
  const refusal = commandExitMismatchRefusal({
    id: 5608,
    command: 'git pull --ff-only origin main',
    actualExitCode: 0,
    expectedExitCode: 20,
  })
  expect(refusal).toContain('command-exit floor expects exit code 20')
  expect(refusal).toContain('close with the outcome configured for exit code 0')
  expect(refusal).toContain('record a command that exits 20')
})

test('a foreign cursor owner adds its compose takeover to an exec refusal', () => {
  const takeover = `${PLATFORM_SLUG} workflow compose flow --project fixture --mode default --arg key=DEV-2370`
  const refusal = commandExitBindingRefusal(
    {
      id: 4,
      sessionMatches: false,
      sessionAdoptedCursor: false,
      createdAfterStepActivation: true,
    },
    false,
    takeover,
  )
  expect(refusal).toContain(takeover)
})

test('a predating exec includes the foreign-owner takeover remedy', () => {
  const takeover = `${PLATFORM_SLUG} workflow compose flow --project fixture --mode default --arg key=DEV-2370`
  const refusal = commandExitBindingRefusal(
    {
      id: 5,
      sessionMatches: true,
      sessionAdoptedCursor: false,
      createdAfterStepActivation: false,
    },
    false,
    takeover,
  )
  expect(refusal).toContain('predates this step becoming active')
  expect(refusal).toContain(takeover)
})
