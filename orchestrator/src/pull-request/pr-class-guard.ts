// concern: pull-request
/** Pure admission for the class guard declared by a measured defect fix. */

import { isAbsolute, join, relative, sep } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { shellQuote } from '../../../shared/shell-quote.ts'
import {
  checkoutRelativePath,
  creditedMeasurementCommands,
  measuredCountFromOutput,
} from '../workflow/workflow-class-measured-floor.ts'

export type ClassGuardMeasurement = { className: string; command: string; count: number }
export type ClassGuardExec = {
  command: string
  cwd: string
  output: string
  exitCode: number
  createdAt: string
}

export type ClassGuardDecision = { kind: 'allow' } | { kind: 'refuse'; message: string }

const rerun = (cwd: string, command: string) =>
  `${PLATFORM_SLUG} workflow exec --cwd ${shellQuote(cwd)} -- ${command}`

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function measurementRerunCwd(input: {
  measurementCwd?: string
  worktree: string
  checkoutRoots: readonly string[]
}): string {
  const measurementCwd = input.measurementCwd
  if (!measurementCwd) return input.worktree
  const containingRoot = [...input.checkoutRoots, input.worktree]
    .filter((root) => isPathInside(root, measurementCwd))
    .sort((left, right) => right.length - left.length)[0]
  if (!containingRoot) return input.worktree
  const directory = checkoutRelativePath(measurementCwd, containingRoot)
  return directory === '.' ? input.worktree : join(input.worktree, directory)
}

export function decidePullRequestClassGuard(input: {
  body: string
  measurement?: ClassGuardMeasurement
  implementClosedAt?: string
  execs: readonly ClassGuardExec[]
  worktree?: string
  checkoutRoots: readonly string[]
  measurementCwd?: string
}): ClassGuardDecision {
  const measurement = input.measurement
  if (!measurement) return { kind: 'allow' }
  const line = input.body.split(/\r?\n/).find((candidate) => candidate.startsWith('Class guard:'))
  if (!line)
    return {
      kind: 'refuse',
      message:
        'fix-defect pull request body is missing `Class guard: <guard name> (before <N>, after <M>)`',
    }
  const parsed = /^Class guard:\s*(.*?)\s*\(before (\d+), after (\d+)\)$/.exec(line)
  if (!parsed)
    return {
      kind: 'refuse',
      message:
        'the Class guard line must be exactly `Class guard: <guard name> (before <N>, after <M>)`',
    }
  if (!parsed[1]?.trim())
    return { kind: 'refuse', message: 'the Class guard line is missing the guard name' }
  if (Number(parsed[2]) !== measurement.count)
    return {
      kind: 'refuse',
      message: `the Class guard before count must equal the measure-class count ${measurement.count}`,
    }
  if (!input.worktree)
    return {
      kind: 'refuse',
      message: `the Class guard rerun location cannot be established; compose the fix-defect cursor with \`--arg worktree=<path>\`, or run \`${PLATFORM_SLUG} pr create\` from the branch's worktree`,
    }
  const worktree = input.worktree
  const creditedCommands = creditedMeasurementCommands(measurement.command, input.checkoutRoots)
  const rerunCommand = creditedCommands.at(-1)!
  const rerunCwd = measurementRerunCwd({
    measurementCwd: input.measurementCwd,
    worktree,
    checkoutRoots: input.checkoutRoots,
  })
  const matchingExecs = input.execs.filter(
    (entry) =>
      creditedCommands.includes(entry.command) &&
      entry.exitCode === 0 &&
      (!input.implementClosedAt || entry.createdAt >= input.implementClosedAt),
  )
  const afterExec = matchingExecs.find((entry) => entry.cwd === rerunCwd)
  if (!afterExec)
    return {
      kind: 'refuse',
      message: matchingExecs.length
        ? `the Class guard post-implement measurement did not run in worktree ${worktree}; run \`${rerun(rerunCwd, rerunCommand)}\``
        : `the Class guard has no successful post-implement measurement; run \`${rerun(rerunCwd, rerunCommand)}\``,
    }
  const afterCount = measuredCountFromOutput(afterExec.output)
  if (afterCount === null || Number(parsed[3]) !== afterCount)
    return {
      kind: 'refuse',
      message: `the Class guard after count must equal the post-implement measurement${afterCount === null ? '' : ` ${afterCount}`}; rerun \`${rerun(rerunCwd, rerunCommand)}\` and update the line`,
    }
  return { kind: 'allow' }
}
