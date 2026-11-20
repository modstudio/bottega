// concern: workflow floor refusal diagnostics
/** Names the failed floor condition and the action that can establish it. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

type CommandExitBindingEvidence = {
  id: number
  sessionMatches: boolean
  sessionAdoptedCursor: boolean
  createdAfterStepActivation: boolean
}

/** Whether these floors accept a pull-request URL as alternative evidence. */
export function floorsAcceptPullRequestLink(
  floors: ReadonlyArray<{ commandEvidence?: string }>,
): boolean {
  return floors.some((floor) => floor.commandEvidence === 'pull-request')
}

export type PassingGateForTree = { number: number } | null | undefined

export function gateFloorRefusal(
  tree: {
    project: string
    worktree?: string | null
    commit: string | null
  },
  passingGateForTree: PassingGateForTree = undefined,
  gateOffered = false,
): string {
  if (tree.commit) {
    const condition =
      passingGateForTree && gateOffered
        ? `floor command-exit is unmet: the offered gate does not meet the floor at ${tree.project} commit ${tree.commit}, and passing gate ${passingGateForTree.number} is recorded for it`
        : passingGateForTree
          ? `floor command-exit is unmet: \`--gate\` was not passed; passing gate ${passingGateForTree.number} is recorded for ${tree.project} commit ${tree.commit}`
          : `floor command-exit is unmet: no passing gate is recorded for ${tree.project} commit ${tree.commit}`
    const remedy = passingGateForTree
      ? `pass \`--gate ${passingGateForTree.number}\``
      : `run \`${PLATFORM_SLUG} gate run\` in the tree at commit ${tree.commit}, then pass \`--gate <gate execution id>\``
    return `${condition}; ${remedy}`
  }
  const condition = tree.worktree
    ? `the recorded cursor worktree ${tree.worktree} was removed or could not be resolved to a commit`
    : 'the cursor has no recorded worktree to resolve to a commit'
  return renderRefusal(
    refusal(`floor command-exit is unmet: ${condition}`, {
      kind: 'edit',
      text: 'pass `--arg worktree=<tree>` naming an existing tree',
    }),
  )
}

export function commandExitBindingRefusal(
  exec: CommandExitBindingEvidence | undefined,
  acceptsPullRequestLink = false,
  takeoverRemedy?: string,
): string | null {
  if (!exec) return null
  const remedy = `run the command again with \`${PLATFORM_SLUG} workflow exec -- <command>\` in this session after the step started`
  if (!exec.sessionMatches && !exec.sessionAdoptedCursor)
    return (
      `command-exit evidence exec:${exec.id} belongs to another session; ${remedy}` +
      (takeoverRemedy ? `; take over this cursor with: ${takeoverRemedy}` : '')
    )
  if (!exec.createdAfterStepActivation)
    return (
      `command-exit evidence exec:${exec.id} predates this step becoming active; ${remedy}` +
      (acceptsPullRequestLink ? '; alternatively, pass `--artifact <the pull request link>`' : '') +
      (takeoverRemedy ? `; take over this cursor with: ${takeoverRemedy}` : '')
    )
  return null
}

export function commandExitMismatchRefusal(input: {
  id: number
  command: string
  actualExitCode: number
  expectedExitCode: number
}): string {
  return (
    `command-exit floor expects exit code ${input.expectedExitCode}, but evidence exec:${input.id} ` +
    `command \`${input.command}\` exited ${input.actualExitCode}; close with the outcome configured for exit code ${input.actualExitCode}, ` +
    `or record a command that exits ${input.expectedExitCode} with \`${PLATFORM_SLUG} workflow exec -- <command>\` and pass the new exec id`
  )
}
