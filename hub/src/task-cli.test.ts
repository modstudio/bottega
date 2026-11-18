import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { TASK_CLOSED_WITH_RESIDUE_EXIT_CODE } from '../../shared/task-close-exit.ts'
import { handleTaskClosedWithResidue } from './task-cli.ts'
import { TaskClosedWithResidueError } from './task-closed-residue.ts'
import type { TaskRow } from './task-row.ts'

const closed = {
  key: 'DEV-1',
  project: PLATFORM_NAME,
  status_category: 'done',
  title: 'Closed task',
} as TaskRow

describe('task closed residue output', () => {
  let savedExitCode: string | number | null | undefined
  let stdout: string[]
  let stderr: string[]

  beforeEach(() => {
    savedExitCode = process.exitCode
    process.exitCode = 0
    stdout = []
    stderr = []
    spyOn(console, 'log').mockImplementation((message) => stdout.push(String(message)))
    spyOn(console, 'error').mockImplementation((message) => stderr.push(String(message)))
  })

  afterEach(() => {
    process.exitCode = 0
    process.exitCode = savedExitCode
    mock.restore()
  })

  test('prints the closed row and residue and sets the composite exit code', () => {
    const error = new TaskClosedWithResidueError(
      closed,
      'cursor-abandon',
      `task DEV-1 is closed; cleanup remains\nclear it with: ${PLATFORM_SLUG} workflow abandon`,
    )

    handleTaskClosedWithResidue(error)

    expect(stdout).toEqual([
      `${'DEV-1'.padEnd(10)} ${'done'.padEnd(8)} ${PLATFORM_NAME.padEnd(12)} Closed task`,
    ])
    expect(stderr).toEqual([error.message])
    expect(process.exitCode).toBe(TASK_CLOSED_WITH_RESIDUE_EXIT_CODE)
  })

  test('rethrows another error without changing the exit code', () => {
    const error = new Error('close refused')
    process.exitCode = 0

    expect(() => handleTaskClosedWithResidue(error)).toThrow(error)
    expect(process.exitCode).toBe(0)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([])
  })
})
