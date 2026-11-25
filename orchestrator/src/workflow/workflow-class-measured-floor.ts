// concern: workflows
/** Pure validation and persistence facts for a class-measured workflow floor. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { parseShellQuoted, shellQuote } from '../../../shared/shell-quote.ts'
import { MAIN_CHECKOUT_WORKTREE_RELATIVE_SEGMENTS } from '../project/worktree-directory.ts'
import type { ValidatedArtifactEvidence } from './workflow-artifact-evidence.ts'

export type ClassMeasurement = {
  className: string
  command: string
  execId: number
  count: number
}

export type ClassMeasuredDecision =
  | { met: true; measurement: ClassMeasurement }
  | { met: false; message: string }

const remedy = `run the class-wide command with \`${PLATFORM_SLUG} workflow exec -- <command>\`, print a non-negative integer as its last stdout line, then pass exactly one \`--artifact exec:<id>\` and \`--class "<class name>"\``

export function measuredCountFromOutput(output: string): number | null {
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  return lastLine && /^\d+$/.test(lastLine) ? Number(lastLine) : null
}

export function renderClassMeasurementCommand(argv: readonly string[] | null): string | null {
  return argv?.length ? argv.map(shellQuote).join(' ') : null
}

type NamedCheckoutPath = { path: string; relative: string }

type CheckoutPathMatch = NamedCheckoutPath & { start: number; end: number }

export function checkoutRelativePath(path: string, root: string): string {
  const relative = path.slice(root.length).replace(/^\/+/, '')
  const segments = relative.split('/')
  const worktreePrefixMatches = MAIN_CHECKOUT_WORKTREE_RELATIVE_SEGMENTS.every(
    (segment, index) => segments[index] === segment,
  )
  const worktreeName = segments[MAIN_CHECKOUT_WORKTREE_RELATIVE_SEGMENTS.length]
  if (worktreePrefixMatches && worktreeName)
    return segments.slice(MAIN_CHECKOUT_WORKTREE_RELATIVE_SEGMENTS.length + 1).join('/') || '.'
  return relative || '.'
}

function checkoutPathMatch(
  argument: string,
  root: string,
  start: number,
): CheckoutPathMatch | null {
  const beforeRoot = argument[start - 1]
  if (beforeRoot !== undefined && /[A-Za-z0-9._\/-]/.test(beforeRoot)) return null
  const afterRoot = argument[start + root.length]
  if (afterRoot !== undefined && afterRoot !== '/') return null
  let end = start + root.length
  while (end < argument.length && !/[\s"'`;&|<>()]/.test(argument[end]!)) end += 1
  const path = argument.slice(start, end)
  return {
    start,
    end,
    path,
    relative: checkoutRelativePath(path, root),
  }
}

function checkoutPathsForRoot(argument: string, root: string): CheckoutPathMatch[] {
  const matches: CheckoutPathMatch[] = []
  let start = argument.indexOf(root)
  while (start !== -1) {
    const match = checkoutPathMatch(argument, root, start)
    if (match) matches.push(match)
    start = argument.indexOf(root, start + 1)
  }
  return matches
}

function checkoutPathsInArgument(
  argument: string,
  checkoutRoots: readonly string[],
): CheckoutPathMatch[] {
  const roots = [
    ...new Set(checkoutRoots.map((root) => root.replace(/\/+$/, '')).filter(Boolean)),
  ].sort((left, right) => right.length - left.length)
  const matches: CheckoutPathMatch[] = []
  for (const root of roots)
    for (const candidate of checkoutPathsForRoot(argument, root))
      if (!matches.some((match) => candidate.start < match.end && candidate.end > match.start))
        matches.push(candidate)
  return matches
}

export function treeRelativeArgv(
  argv: readonly string[],
  checkoutRoots: readonly string[],
): string[] {
  return argv.map((argument, index) => {
    if (index === 0) return argument
    const matches = checkoutPathsInArgument(argument, checkoutRoots).sort(
      (left, right) => right.start - left.start,
    )
    let rewritten = argument
    for (const match of matches)
      rewritten = `${rewritten.slice(0, match.start)}${match.relative}${rewritten.slice(match.end)}`
    return rewritten
  })
}

export function creditedMeasurementCommands(
  command: string,
  checkoutRoots: readonly string[],
): string[] {
  const argv = parseShellQuoted(command)
  if (!argv) return [command]
  const rewritten = treeRelativeArgv(argv, checkoutRoots)
  if (rewritten.every((argument, index) => argument === argv[index])) return [command]
  return [renderClassMeasurementCommand(rewritten)!]
}

export function decideClassMeasuredFloor(input: {
  className?: string
  artifacts: readonly ValidatedArtifactEvidence[]
  checkoutRoots: readonly string[]
}): ClassMeasuredDecision {
  const className = input.className?.trim()
  if (!className)
    return { met: false, message: `floor class-measured is unmet: --class is missing; ${remedy}` }
  if (containsSecretShaped(className))
    return {
      met: false,
      message: `floor class-measured is unmet: --class contains secret-shaped content; ${remedy}`,
    }
  if (input.artifacts.length !== 1 || !input.artifacts[0]?.exec)
    return {
      met: false,
      message: `floor class-measured is unmet: exactly one exec artifact is required; ${remedy}`,
    }
  const exec = input.artifacts[0].exec
  if (exec.exitCode !== 0)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} exited ${exec.exitCode}; ${remedy}`,
    }
  if (!exec.createdAfterStepActivation)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} predates this step; ${remedy}`,
    }
  const command = exec.commandWithheld ? null : renderClassMeasurementCommand(exec.argv)
  if (!command)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} has no structured command; rerun the measurement through \`${PLATFORM_SLUG} workflow exec -- <command>\``,
    }
  const checkoutPath = exec.argv
    ?.slice(1)
    .flatMap((argument) => checkoutPathsInArgument(argument, input.checkoutRoots))
    .at(0)
  if (checkoutPath)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} names checkout path \`${checkoutPath.path}\`; use its tree-relative form \`${checkoutPath.relative}\` and rerun the command through \`${PLATFORM_SLUG} workflow exec -- <command>\``,
    }
  const count = measuredCountFromOutput(exec.output)
  if (count === null)
    return {
      met: false,
      message: `floor class-measured is unmet: exec:${exec.id} stdout does not end in a non-negative integer; ${remedy}`,
    }
  return {
    met: true,
    measurement: { className, command, execId: exec.id, count },
  }
}
