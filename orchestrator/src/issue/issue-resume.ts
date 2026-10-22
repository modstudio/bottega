// concern: filed-issue resume commands
/** Selects restart or ship-existing-branch instructions for each handback path. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { IssueWorkerReply } from '../contract/contract.ts'
import type { Project } from '../project/projects.ts'
import type { RunResult } from '../run/run-types.ts'

export function issueResumeLine(
  issueKey: string,
  fix?: {
    runNumber: number
    target: string
    branchKey: string
    branch: string | null
  },
): string {
  return fix?.branch
    ? `Resume with: ${PLATFORM_SLUG} tree open ${fix.runNumber}, then ${PLATFORM_SLUG} workflow compose ship-task --project ${fix.target} --mode merge --arg key=${fix.branchKey} --arg branch=${fix.branch} --arg worktree=<path tree open prints>`
    : `Resume with: ${PLATFORM_SLUG} workflow fix-defect ${issueKey}`
}

export function fixVerificationResumeLine(input: {
  ready: boolean
  issueKey: string
  fixRun: RunResult
  fix: IssueWorkerReply
  target: Project
  branchKey: string
}): string | undefined {
  return input.ready
    ? undefined
    : issueResumeLine(input.issueKey, {
        runNumber: input.fixRun.number,
        target: input.target.name,
        branchKey: input.branchKey,
        branch: input.fixRun.worktree?.branch ?? input.fix.branch,
      })
}

export function issueFailureResumeLine(input: {
  issueKey: string
  fixRunNumber: number | null
  failedRunNumber: number | null
  target: string | null
  branchKey: string | null
  branch: string | null
}): string {
  const runNumber = input.fixRunNumber ?? input.failedRunNumber
  return runNumber !== null && input.target && input.branchKey && input.branch
    ? issueResumeLine(input.issueKey, {
        runNumber,
        target: input.target,
        branchKey: input.branchKey,
        branch: input.branch,
      })
    : issueResumeLine(input.issueKey)
}
