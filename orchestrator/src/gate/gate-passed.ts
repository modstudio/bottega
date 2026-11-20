// concern: recorded project gate lookup
/** Answers whether one project commit has an exact passing gate record. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'
import { projectAt } from '../project/projects.ts'
import { passingGateNumberForProjectCommit } from './gate-passing-lookup.ts'

export function passingGateForCommit(
  commit: string,
  cwd = process.cwd(),
  d: Database = db(),
): { project: string; commit: string; gateNumber: number | null } {
  const project = projectAt(cwd, d)
  if (!project)
    throw new Error(`${PLATFORM_SLUG} gate passed: no registered project contains ${cwd}`)
  const normalized = commit.trim()
  if (!normalized) throw new Error(`${PLATFORM_SLUG} gate passed requires a commit`)
  return {
    project: project.name,
    commit: normalized,
    gateNumber: passingGateNumberForProjectCommit(
      d,
      normalized,
      project.recordId,
      (gateCwd) => projectAt(gateCwd, d)?.recordId ?? null,
    ),
  }
}

export function passingGateForArgument(
  argument: string,
  cwd = process.cwd(),
  d: Database = db(),
  resolveCommit: (checkout: string, argument: string) => string = resolveCommitArgument,
): ReturnType<typeof passingGateForCommit> {
  const normalized = argument.trim()
  if (!normalized) return passingGateForCommit(normalized, cwd, d)
  return passingGateForCommit(resolveCommit(cwd, normalized), cwd, d)
}

export function formatPassingGate(result: ReturnType<typeof passingGateForCommit>): string {
  return result.gateNumber === null
    ? `no passing gate recorded for ${result.project} commit ${result.commit}`
    : `passing gate ${result.gateNumber} recorded for ${result.project} commit ${result.commit}`
}
