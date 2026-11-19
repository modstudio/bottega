// concern: project landing-branch decision
/** Decides how registration obtains a landing branch without performing I/O. */

import type { ProjectSettings } from './project-settings.ts'

export type ProjectLandingBranchDecision =
  | { kind: 'branch'; trunk: string; source: 'declared' | 'origin/HEAD' }
  | { kind: 'untouched' }
  | { kind: 'refuse'; reason: string }

export function decideProjectLandingBranch(input: {
  path: string
  settings: ProjectSettings
  gitWorkTree: boolean
  remoteDefaultBranch: string | null
}): ProjectLandingBranchDecision {
  const declared = input.settings.trunk?.trim()
  if (declared) return { kind: 'branch', trunk: declared, source: 'declared' }
  if (!input.gitWorkTree) return { kind: 'untouched' }
  if (input.remoteDefaultBranch) {
    return { kind: 'branch', trunk: input.remoteDefaultBranch, source: 'origin/HEAD' }
  }
  return {
    kind: 'refuse',
    reason:
      `project add refused: cannot infer the landing branch of ${input.path}: ` +
      `refs/remotes/origin/HEAD is not set; cleared by: git -C ${input.path} remote set-head origin --auto, ` +
      `or pass --settings '{"trunk":"<branch>"}'`,
  }
}
