import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, fenceStoreAfterCheckoutMove, writableDb } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import type { RequiredReleaseReport } from '../release/release-required.ts'
import type { ShipCleanupReport } from '../ship-cleanup/ship-cleanup.ts'
import { decideShipCleanupVerdict } from '../ship-cleanup/ship-cleanup-decision.ts'
import type { PullRequestMergeFacts } from './pr-merge-evidence.ts'
import {
  completePullRequestPostLanding,
  POST_LANDING_REPORTED_EXIT_CODE,
  type PullRequestPostLandingAdapter,
  type PullRequestPostLandingChildAdapter,
  postLandingHandOffInvocation,
  runPullRequestPostLanding,
} from './pr-post-landing.ts'
import {
  type PullRequestPostLandingPayload,
  postLandingRecovery,
} from './pr-post-landing-payload.ts'

const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

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
  project?: Project
  workflowPromotionDue?: boolean
  releaseRequired?: boolean
  calls?: string[]
}) {
  return completePullRequestPostLanding({
    adapter: remaining(input.calls ?? []),
    postLandingAdapter: input.post,
    database: db(),
    project: input.project ?? project,
    pullRequest,
    mergeCommit: 'merge-commit',
    target: '42',
    releaseRequired: input.releaseRequired ?? true,
    workflowPromotionDue: input.workflowPromotionDue ?? false,
  })
}

test('a successful move fences this process and hands off the exact fixed identity', () => {
  const received: PullRequestPostLandingPayload[] = []
  const handOffProjects: string[] = []
  const outcome = complete({
    workflowPromotionDue: true,
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      entryClosure: () => new Map(),
      mainHead: () => 'main-before',
      moveMain: () => {},
      fence: fenceStoreAfterCheckoutMove,
      handOff: (payload, movedProject) => {
        received.push(payload)
        handOffProjects.push(movedProject.path)
        return { output: 'child output', exitCode: 0 }
      },
    },
  })

  expect(outcome).toEqual({ output: 'child output', exitCode: 0 })
  expect(handOffProjects).toEqual([project.path])
  expect(received[0]).toEqual({
    project: PLATFORM_SLUG,
    target: '42',
    prNumber: 42,
    headBranch: 'DEV-2004-post-landing',
    headCommit: 'head-commit',
    mergeCommit: 'merge-commit',
    requiredRungs: ['hosted-api'],
    rungDecisionError: null,
    releaseRequired: true,
    promoteWorkflowDrafts: true,
    recordingError: null,
    requeueOutput: null,
  })
  expect(() => writableDb()).toThrow('orchestrator store is fenced after checkout move')
  expect(() => writableDb()).toThrow('its post-landing child owns the store')
  expect(() => writableDb()).toThrow(postLandingRecovery('42'))
})

test('the post-landing child runs from main through its binary or the embedded executable', () => {
  expect(postLandingHandOffInvocation(project.path, false)).toEqual({
    argv: [`${project.path}/bin/${PLATFORM_SLUG}`],
    cwd: project.path,
  })
  expect(postLandingHandOffInvocation(project.path, true)).toEqual({
    argv: [process.execPath],
    cwd: project.path,
  })
})

test('a change inside a rung entry closure requires that rung and hands it off', () => {
  const entryProject = {
    ...project,
    settings: {
      ...project.settings,
      release: {
        ...project.settings.release,
        rungs: [
          { name: 'hosted-api', branch: 'main', requiredWhenChanged: ['shared/record/**'] },
          { name: 'hosted-hub', branch: 'main', live: 'hub', entryPoints: ['hub/src/hosted.ts'] },
        ],
      },
    },
  } as Project
  const asked: Array<{ mergeCommit: string; entries: readonly string[] }> = []
  const received: PullRequestPostLandingPayload[] = []
  complete({
    project: entryProject,
    post: {
      changedPaths: () => ['shared/machine-label.ts'],
      entryClosure: (_project, mergeCommit, entries) => {
        asked.push({ mergeCommit, entries })
        return new Map([
          ['hub/src/hosted.ts', new Set(['hub/src/hosted.ts', 'shared/machine-label.ts'])],
        ])
      },
      mainHead: () => 'main-before',
      moveMain: () => {},
      fence: () => {},
      handOff: (payload) => {
        received.push(payload)
        return { output: '', exitCode: 0 }
      },
    },
  })

  expect(asked).toEqual([{ mergeCommit: 'merge-commit', entries: ['hub/src/hosted.ts'] }])
  expect(received[0]?.requiredRungs).toEqual(['hosted-hub'])
})

test('the real post-landing adapter refuses before git or spawn under the test runner', () => {
  const spawnSync = Bun.spawnSync
  let spawnCount = 0
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    spawnCount++
    return spawnSync(...args)
  }) as typeof Bun.spawnSync
  const began = performance.now()
  let outcome: ReturnType<typeof completePullRequestPostLanding>
  try {
    outcome = completePullRequestPostLanding({
      adapter: remaining([]),
      database: db(),
      project: { ...project, path: cwd },
      pullRequest,
      mergeCommit: 'merge-commit',
      target: '42',
      releaseRequired: false,
      workflowPromotionDue: true,
    })
  } finally {
    Bun.spawnSync = spawnSync
  }
  const elapsedMs = performance.now() - began

  expect(spawnCount).toBe(0)
  expect(outcome.output).toContain(
    'real pull-request post-landing adapter refuses side effects under the test runner; inject a post-landing adapter',
  )
  console.log(`post-landing real-adapter class guard: ${elapsedMs.toFixed(3)}ms`)
})

test('the real child adapter refuses before spawn under the test runner', () => {
  const database = db()
  database
    .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(
      project.recordId,
      project.name,
      project.path,
      project.stack,
      JSON.stringify(project.settings),
    )
  const spawnSync = Bun.spawnSync
  let spawnCount = 0
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    spawnCount++
    return spawnSync(...args)
  }) as typeof Bun.spawnSync
  const began = performance.now()
  let outcome: ReturnType<typeof runPullRequestPostLanding>
  try {
    outcome = runPullRequestPostLanding(childPayload(), database)
  } finally {
    Bun.spawnSync = spawnSync
  }
  const elapsedMs = performance.now() - began

  expect(spawnCount).toBe(0)
  expect(outcome.output).toContain(
    'real pull-request post-landing adapter refuses side effects under the test runner; inject a post-landing adapter',
  )
  console.log(`post-landing real-child-adapter class guard: ${elapsedMs.toFixed(3)}ms`)
})

test('when no move is due all remaining work stays in process and the store stays open', () => {
  const calls: string[] = []
  const outcome = complete({
    releaseRequired: false,
    calls,
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      entryClosure: () => new Map(),
      mainHead: () => 'main-before',
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
      entryClosure: () => new Map(),
      mainHead: () => 'main-before',
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
  expect(outcome.output).toContain(`${project.path}/bin/${PLATFORM_SLUG} machine update`)
  expect(outcome.output).toContain(`remedy: ${PLATFORM_SLUG} pr merge 42 --release-required`)
  expect(calls).toEqual(['cleanup'])
  expect(writableDb()).toBeDefined()
})

test.each([0, 20, 21])('the parent propagates child output and exit %i', (exitCode) => {
  const outcome = complete({
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      entryClosure: () => new Map(),
      mainHead: () => 'main-before',
      moveMain: () => {},
      fence: () => {},
      handOff: () => ({ output: `child output ${exitCode}`, exitCode }),
    },
  })
  expect(outcome).toEqual({ output: `child output ${exitCode}`, exitCode })
})

const childPayload = (overrides: Partial<PullRequestPostLandingPayload> = {}) => ({
  project: PLATFORM_SLUG,
  target: '42',
  prNumber: 42,
  headBranch: pullRequest.headBranch,
  headCommit: pullRequest.headCommit,
  mergeCommit: 'merge-commit',
  requiredRungs: ['hosted-api'],
  rungDecisionError: null,
  releaseRequired: true,
  promoteWorkflowDrafts: false,
  recordingError: null,
  requeueOutput: null,
  ...overrides,
})

const childAdapter = (
  overrides: Partial<PullRequestPostLandingChildAdapter> = {},
): PullRequestPostLandingChildAdapter => ({
  project: () => project,
  verify: () => {},
  promote: () => ({ ok: true, output: '' }),
  release: () => satisfied,
  cleanup: () => cleanReport(),
  ...overrides,
})

test('the child fails every declared rung when the parent could not decide', () => {
  const outcome = runPullRequestPostLanding(
    childPayload({
      requiredRungs: ['hosted-api', 'worker'],
      rungDecisionError: 'changed paths unavailable',
    }),
    db(),
    childAdapter({
      release: () => {
        throw new Error('release must not run')
      },
    }),
  )

  expect(outcome.exitCode).toBe(21)
  expect(outcome.output).toContain(
    'required rung hosted-api: deploy exit not run; changed paths unavailable',
  )
  expect(outcome.output).toContain(
    'required rung worker: deploy exit not run; changed paths unavailable',
  )
})

test('the child reports checkout verification failure with the rung remedy', () => {
  const outcome = runPullRequestPostLanding(
    childPayload(),
    db(),
    childAdapter({
      verify: () => {
        throw new Error('main does not contain the landing commit')
      },
    }),
  )

  expect(outcome.exitCode).toBe(21)
  expect(outcome.output).toContain(
    'required rung hosted-api: deploy exit not run; main does not contain the landing commit',
  )
  expect(outcome.output).toContain(`remedy: ${PLATFORM_SLUG} pr merge 42 --release-required`)
})

test('the child uses the shared absent release flag report', () => {
  const outcome = runPullRequestPostLanding(
    childPayload({ releaseRequired: false }),
    db(),
    childAdapter(),
  )

  expect(outcome.exitCode).toBe(21)
  expect(outcome.output).toContain('not released because --release-required was absent')
})

test('a child promote throw still runs release and cleanup', () => {
  const calls: string[] = []
  const outcome = runPullRequestPostLanding(
    childPayload({ promoteWorkflowDrafts: true }),
    db(),
    childAdapter({
      promote: () => {
        calls.push('promote')
        throw new Error('promote process could not start')
      },
      release: () => {
        calls.push('release')
        return satisfied
      },
      cleanup: () => {
        calls.push('cleanup')
        return cleanReport()
      },
    }),
  )

  expect(calls).toEqual(['promote', 'release', 'cleanup'])
  expect(outcome.exitCode).toBe(20)
  expect(outcome.output).toContain(
    'workflow draft promotion failed at promote: promote process could not start',
  )
  expect(outcome.output).toContain(`${PLATFORM_SLUG} workflow promote-tree`)
})

test('a recovery with a required rung moves, fences, and hands off', () => {
  const events: string[] = []
  complete({
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      entryClosure: () => new Map(),
      mainHead: () => 'main-head',
      moveMain: () => events.push('move'),
      fence: () => events.push('fence'),
      handOff: () => {
        events.push('hand-off')
        return { output: 'recovered', exitCode: 0 }
      },
    },
  })

  expect(events).toEqual(['move', 'fence', 'hand-off'])
})

test('a failed required-rung decision is carried to the child with every declared rung', () => {
  const received: PullRequestPostLandingPayload[] = []
  const projectWithTwoRungs = {
    ...project,
    settings: {
      ...project.settings,
      release: {
        ...project.settings.release!,
        rungs: [
          { name: 'hosted-api', branch: 'main', requiredWhenChanged: ['shared/record/**'] },
          { name: 'worker', branch: 'main', requiredWhenChanged: ['orchestrator/**'] },
        ],
      },
    },
  } as Project

  completePullRequestPostLanding({
    adapter: remaining([]),
    postLandingAdapter: {
      changedPaths: () => {
        throw new Error('changed paths unavailable')
      },
      entryClosure: () => new Map(),
      mainHead: () => 'main-before',
      moveMain: () => {},
      fence: () => {},
      handOff: (payload) => {
        received.push(payload)
        return { output: 'child output', exitCode: 21 }
      },
    },
    database: db(),
    project: projectWithTwoRungs,
    pullRequest,
    mergeCommit: 'merge-commit',
    target: '42',
    releaseRequired: true,
    workflowPromotionDue: false,
  })

  expect(received[0]?.rungDecisionError).toBe('changed paths unavailable')
  expect(received[0]?.requiredRungs).toEqual(['hosted-api', 'worker'])
})

test('a partial move that changes HEAD still fences and hands off', () => {
  const events: string[] = []
  let head = 'before'
  const outcome = complete({
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      entryClosure: () => new Map(),
      mainHead: () => head,
      moveMain: () => {
        head = 'after'
        throw new Error('verification raced with a dirty checkout')
      },
      fence: () => events.push('fence'),
      handOff: () => {
        events.push('hand-off')
        return { output: 'child verifies main', exitCode: 0 }
      },
    },
  })

  expect(outcome).toEqual({ output: 'child verifies main', exitCode: 0 })
  expect(events).toEqual(['fence', 'hand-off'])
})

test('a failed HEAD re-read after a move attempt still fences and hands off', () => {
  const events: string[] = []
  let headReads = 0
  const outcome = complete({
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      entryClosure: () => new Map(),
      mainHead: () => {
        headReads += 1
        if (headReads === 1) return 'before'
        throw new Error('cannot read main HEAD after move')
      },
      moveMain: () => {
        throw new Error('move verification failed')
      },
      fence: () => events.push('fence'),
      handOff: () => {
        events.push('hand-off')
        return { output: 'child verifies main', exitCode: 0 }
      },
    },
  })

  expect(outcome).toEqual({ output: 'child verifies main', exitCode: 0 })
  expect(events).toEqual(['fence', 'hand-off'])
})

test('a non-ladder child exit keeps its code and adds the parent recovery', () => {
  const outcome = complete({
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      entryClosure: () => new Map(),
      mainHead: () => 'main-head',
      moveMain: () => {},
      fence: () => {},
      handOff: () => ({ output: 'store is behind', exitCode: 1 }),
    },
  })

  expect(outcome.exitCode).toBe(1)
  expect(outcome.output).toContain('store is behind')
  expect(outcome.output).toContain(
    'post-landing steps (promotion, rungs, cleanup) did not complete',
  )
  expect(outcome.output).toContain(`${PLATFORM_SLUG} machine update`)
  expect(outcome.output).toContain(`${PLATFORM_SLUG} pr merge 42 --release-required`)
})

test('a child-reported failure keeps its code and prints the recovery once', () => {
  const remedy = postLandingRecovery('42')
  const outcome = complete({
    post: {
      changedPaths: () => ['shared/record/schema.ts'],
      entryClosure: () => new Map(),
      mainHead: () => 'main-head',
      moveMain: () => {},
      fence: () => {},
      handOff: () => ({
        output: `post-landing steps did not complete: store is behind; ${remedy}`,
        exitCode: POST_LANDING_REPORTED_EXIT_CODE,
      }),
    },
  })

  expect(outcome.exitCode).toBe(POST_LANDING_REPORTED_EXIT_CODE)
  expect(
    outcome.output.match(new RegExp(remedy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')),
  ).toHaveLength(1)
})
