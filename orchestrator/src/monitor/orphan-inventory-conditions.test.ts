import { expect, test } from 'bun:test'
import { orphanComposeResourceConditions } from './orphan-inventory-conditions.ts'

test('reports the exact Compose lifecycle action for a vanished worktree directory', () => {
  expect(
    orphanComposeResourceConditions([
      {
        kind: 'container',
        name: 'web-1',
        project: 'orch_web',
        workingDir: '/code/app/.claude/worktrees/gone',
        workingDirExists: false,
      },
    ]),
  ).toEqual([
    expect.objectContaining({
      kind: 'orphan-compose-resource',
      action: 'report only; lifecycle action is docker compose -p orch_web down',
    }),
  ])
})

test('does not report an existing Compose directory', () => {
  expect(
    orphanComposeResourceConditions([
      {
        kind: 'container',
        name: 'web-1',
        project: 'orch_web',
        workingDir: '/code/app/.claude/worktrees/live',
        workingDirExists: true,
      },
    ]),
  ).toEqual([])
})

test('does not report a missing directory outside the worktree root', () => {
  expect(
    orphanComposeResourceConditions([
      {
        kind: 'container',
        name: 'web-1',
        project: 'orch_web',
        workingDir: '/code/app/deleted',
        workingDirExists: false,
      },
    ]),
  ).toEqual([])
})

test('reports one row when the inventory repeats the same Docker object', () => {
  const resource = {
    kind: 'container' as const,
    name: 'web-1',
    project: 'orch_web',
    workingDir: '/code/app/.claude/worktrees/gone',
    workingDirExists: false,
  }
  expect(orphanComposeResourceConditions([resource, resource])).toHaveLength(1)
})
