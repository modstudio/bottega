import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, fenceStoreAfterCheckoutMove, writableDb } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import type { RequiredReleaseReport } from '../release/release-required.ts'
import type { ShipCleanupReport } from '../ship-cleanup/ship-cleanup.ts'
import { decideShipCleanupVerdict } from '../ship-cleanup/ship-cleanup-decision.ts'
import type { PullRequestChange } from './pr-admission.ts'
import type { PullRequestMergeFacts } from './pr-merge-evidence.ts'
import {
  completePullRequestPostLanding,
  type PullRequestPostLandingAdapter,
} from './pr-post-landing.ts'
import type { PullRequestPostLandingPayload } from './pr-post-landing-payload.ts'

const project = {
  recordId: '01990000-0000-7000-8000-000000002004',
  name: PLATFORM_SLUG,
  path: `/fixture/${PLATFORM_SLUG}`,
  stack: 'bun',
  canon: true,
  retiredAt: null,
  settings: {
    trunk: 'main',
    release: {
      mergeMethod: 'squash',
      requiredChecks: [],
      rungs: [{ name: 'hosted-api', branch: 'main', requiredWhenChanged: ['shared/record/**'] }],
    },
  },
} as Project

const pullRequest: PullRequestMergeFacts = {
  nodeId: 'PR_node',
  number: 42,
  headCommit: 'head-commit',
  headBranch: 'DEV-2004-post-landing',
  baseBranch: 'main',
  title: 'Hand off post-landing work',
  state: 'OPEN',
  mergeCommit: null,
}

const change = {
  project,
  branch: pullRequest.headBranch,
  group: { pathSet: ['shared/record/schema.ts'] },
} as PullRequestChange

const cleanReport = (): ShipCleanupReport => ({
  project: project.name,
  branch: pullRequest.headBranch,
  landingBranch: 'main',
  mainCheckoutPath: project.path,
  freed: { artifacts: 0, scratch: 0, worktrees: 0 },
  removed: { artifacts: [], scratch: [], worktrees: [], branches: [] },
  absentWorktrees: [],
  reclaimed: { processes: [], compose: [] },
  gone: [],
  kept: [],
  errors: [],
  verdict: decideShipCleanupVerdict({ kept: [], errors: [] }),
})

const satisfied: RequiredReleaseReport = {
  required: ['hosted-api'],
  releases: [
    {
      rung: 'hosted-api',
      deployExit: 0,
      outputTail: 'already live at release-commit',
      satisfied: true,
      deployed: false,
    },
  ],
  satisfied: true,
}

const remaining = (calls: string[]) => ({
  promote: () => ({ ok: true as const, output: 'promoted workflow drafts' }),
  release: () => {
    calls.push('release')
    return satisfied
  },
  cleanup: () => {
    calls.push('cleanup')
    return cleanReport()
  },
})

function complete(input: {
  post: PullRequestPostLandingAdapter
  workflowPromotionDue?: boolean
  releaseRequired?: boolean
  calls?: string[]
}) {
  return completePullRequestPostLanding({
    adapter: remaining(input.calls ?? []),
    postLandingAdapter: input.post,
    database: db(),
    project,
    change,
    pullRequest,
    mergeCommit: 'merge-commit',
    target: '42',
    releaseRequired: input.releaseRequired ?? true,
    workflowPromotionDue: input.workflowPromotionDue ?? false,
    alreadyMerged: false,
  })
}

test('a successful move fences this process and hands off the exact fixed identity', () => {
  const received: PullRequestPostLandingPayload[] = []
  const outcome = complete({
    workflowPromotionDue: true,
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      moveMain: () => {},
      fence: fenceStoreAfterCheckoutMove,
      handOff: (payload) => {
        received.push(payload)
        return { output: 'child output', exitCode: 0 }
      },
    },
  })

  expect(outcome).toEqual({ output: 'child output', exitCode: 0 })
  expect(received[0]).toEqual({
    project: PLATFORM_SLUG,
    target: '42',
    prNumber: 42,
    headBranch: 'DEV-2004-post-landing',
    headCommit: 'head-commit',
    mergeCommit: 'merge-commit',
    requiredRungs: ['hosted-api'],
    releaseRequired: true,
    promoteWorkflowDrafts: true,
    recordingError: null,
    requeueOutput: null,
  })
  expect(() => writableDb()).toThrow('orchestrator store is fenced after checkout move')
})

test('when no move is due all remaining work stays in process and the store stays open', () => {
  const calls: string[] = []
  const outcome = complete({
    releaseRequired: false,
    calls,
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      moveMain: () => {
        throw new Error('move must not run')
      },
      fence: () => {
        throw new Error('fence must not run')
      },
      handOff: () => {
        throw new Error('hand-off must not run')
      },
    },
  })

  expect(outcome.exitCode).toBe(0)
  expect(calls).toEqual(['release', 'cleanup'])
  expect(writableDb()).toBeDefined()
})

test('a move failure reports every rung and remedy, cleans up, and does not fence or hand off', () => {
  const calls: string[] = []
  const outcome = complete({
    calls,
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      moveMain: () => {
        throw new Error('registered main checkout is dirty; clean it')
      },
      fence: () => {
        throw new Error('fence must not run')
      },
      handOff: () => {
        throw new Error('hand-off must not run')
      },
    },
  })

  expect(outcome.exitCode).toBe(21)
  expect(outcome.output).toContain(
    'required rung hosted-api: deploy exit not run; registered main checkout is dirty; clean it',
  )
  expect(outcome.output).toContain(`remedy: ${PLATFORM_SLUG} pr merge 42 --release-required`)
  expect(calls).toEqual(['cleanup'])
  expect(writableDb()).toBeDefined()
})

test.each([0, 20, 21])('the parent propagates child output and exit %i', (exitCode) => {
  const outcome = complete({
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      moveMain: () => {},
      fence: () => {},
      handOff: () => ({ output: `child output ${exitCode}`, exitCode }),
    },
  })
  expect(outcome).toEqual({ output: `child output ${exitCode}`, exitCode })
})
