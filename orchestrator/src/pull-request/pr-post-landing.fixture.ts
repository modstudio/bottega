import type { Database } from 'bun:sqlite'
import type { Project } from '../project/projects.ts'
import type { RequiredReleaseReport } from '../release/release-required.ts'
import type { ShipCleanupReport } from '../ship-cleanup/ship-cleanup.ts'
import {
  type PullRequestPostLandingAdapter,
  runPullRequestPostLanding,
  type WorkflowPromotionResult,
} from './pr-post-landing.ts'

/** Test-only in-process replacement for the fresh-process hand-off. */
export function inProcessPostLandingAdapter(input: {
  database: Database
  project(): Project
  promote?(): string | WorkflowPromotionResult
  release(enabled: boolean): RequiredReleaseReport
  cleanup(): ShipCleanupReport
}): PullRequestPostLandingAdapter {
  return {
    changedPaths: () => [],
    mainHead: () => 'main-head',
    moveMain: () => {},
    fence: () => {},
    handOff: (payload) =>
      runPullRequestPostLanding(payload, input.database, {
        project: input.project,
        verify: () => {},
        promote: () => fixturePromotionResult(input.promote),
        release: () => input.release(payload.releaseRequired),
        cleanup: input.cleanup,
      }),
  }
}

export function fixturePromotionResult(
  promote?: () => string | WorkflowPromotionResult,
): WorkflowPromotionResult {
  try {
    const result = promote?.() ?? ''
    return typeof result === 'string' ? { ok: true, output: result } : result
  } catch (cause) {
    return {
      ok: false,
      stage: 'promote',
      detail: cause instanceof Error ? cause.message : String(cause),
    }
  }
}
