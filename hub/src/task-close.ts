import { pruneTaskBranches, releaseTaskClaims } from './orch.ts'
import { closeTask, type TaskRow } from './task.ts'
import type { Attribution } from './task-attribution.ts'
import { NO_ATTRIBUTION } from './task-attribution.ts'
import type { TaskScope } from './task-identity.ts'

export async function closeThenPrune(
  key: string,
  scope: TaskScope,
  keepBranches: boolean,
  abandonReason: string | undefined,
  attributionOrDependencies:
    | Attribution
    | {
        close?: (
          key: string,
          scope: TaskScope,
          options: { abandonReason?: string },
        ) => Promise<TaskRow>
        prune?: typeof pruneTaskBranches
        releaseClaims?: typeof releaseTaskClaims
      } = NO_ATTRIBUTION,
  suppliedDependencies: {
    close?: (
      key: string,
      scope: TaskScope,
      attribution: Attribution,
      options: { abandonReason?: string },
    ) => Promise<TaskRow>
    prune?: typeof pruneTaskBranches
    releaseClaims?: typeof releaseTaskClaims
  } = {},
) {
  const attributed = 'actorUserId' in attributionOrDependencies
  const attribution = attributed ? attributionOrDependencies : NO_ATTRIBUTION
  const dependencies = attributed ? suppliedDependencies : attributionOrDependencies
  const closed = dependencies.close
    ? attributed
      ? await (dependencies.close as NonNullable<typeof suppliedDependencies.close>)(
          key,
          scope,
          attribution,
          { abandonReason },
        )
      : await (
          dependencies.close as (
            key: string,
            scope: TaskScope,
            options: { abandonReason?: string },
          ) => Promise<TaskRow>
        )(key, scope, { abandonReason })
    : await closeTask(key, scope, attribution, { abandonReason })
  let claimReleaseError: Error | null = null
  try {
    await (dependencies.releaseClaims ?? releaseTaskClaims)(closed.project, closed.key)
  } catch (error) {
    claimReleaseError = error as Error
  }
  if (keepBranches) return { closed, pruned: null, pruneError: null, claimReleaseError }
  try {
    return {
      closed,
      pruned: await (dependencies.prune ?? pruneTaskBranches)(closed.project, closed.key),
      pruneError: null,
      claimReleaseError,
    }
  } catch (error) {
    return { closed, pruned: null, pruneError: error as Error, claimReleaseError }
  }
}
