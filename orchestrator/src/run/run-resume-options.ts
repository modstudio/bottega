// concern: run-resume-options
/** Shared in-process shape for a retained conversation workspace. */

import type { Worktree } from '../worktree/worktree-types.ts'
import type { ResumeTreePlan } from './resume-tree.ts'
import type { ResumeKind } from './run-resume-kind.ts'

export type RunResumeOptions = {
  kind: ResumeKind
  parent: number
  agent: string
  session?: string
  retireAsking?: boolean
  turn: number
  sessionId: string | null
  worktree: Worktree | null
  treePlan?: Extract<ResumeTreePlan, { action: 'recreate-on-branch' | 'recreate-then-restore' }>
}
