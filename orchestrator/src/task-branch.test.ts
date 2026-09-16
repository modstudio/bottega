import { describe, expect, test } from 'bun:test'
import { isTaskBranchSuperseded, type TaskBranchRunRow } from './task-branch.ts'

const row = (
  id: number,
  branch: string,
  launchBase: string | null,
  parentRunId: number | null = null,
): TaskBranchRunRow => ({
  id,
  parent_run_id: parentRunId,
  branch,
  launch_base: launchBase,
})

describe('task branch supersession', () => {
  test('a later explicit-base root run supersedes an earlier branch', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', 'main'),
      ]),
    ).toBe(true)
  })

  test('a later root run without a launch base does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', null),
      ]),
    ).toBe(false)
  })

  test('a later resume with an inherited launch base does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', 'main', 9),
      ]),
    ).toBe(false)
  })

  test('a later explicit-base run on the same branch does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-old', 'main'),
      ]),
    ).toBe(false)
  })
})
