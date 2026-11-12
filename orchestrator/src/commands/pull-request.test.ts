import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { fenceStoreAfterCheckoutMove, writableDb } from '../database/db.ts'
import { getContext, setContextItem } from '../doc/context-service.ts'
import {
  CONTEXT_FACTS_PORTS_KEY,
  type ContextFactsPorts,
} from '../doc/context-write-adapter.ts'
import { upsertProject } from '../project/projects.ts'
import { POST_LANDING_REPORTED_EXIT_CODE } from '../pull-request/pr-landed-exit-codes.ts'
import { encodePullRequestPostLandingPayload } from '../pull-request/pr-post-landing-payload.ts'
import {
  applyParentPullRequestContextMoment,
  runPullRequestPostLandingCommand,
} from './pull-request.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}

afterEach(() => {
  delete globals[CONTEXT_FACTS_PORTS_KEY]
})

test('a fenced parent leaves the post-landing child to apply the context moment', async () => {
  fenceStoreAfterCheckoutMove('the child owns the store')
  let reads = 0
  const messages: string[] = []

  await applyParentPullRequestContextMoment(
    ['DEV'],
    {
      exitCode: 0,
      headBranch: 'feature/DEV-2270-context',
      pullRequestNumber: 314,
      mergeCommit: '0123456789abcdef',
    },
    {
      getContext: async () => {
        reads += 1
        throw new Error('the fenced parent read context')
      },
      log: (message) => messages.push(String(message)),
    },
  )

  expect(reads).toBe(0)
  expect(messages).toEqual([])
})

test('the post-landing child applies the moment after a post-landing failure', async () => {
  const task = { key: 'DEV-2270', record_id: newRecordId(), project: PLATFORM_SLUG }
  upsertProject({
    recordId: newRecordId(),
    name: PLATFORM_SLUG,
    path: '/tmp/post-landing-context',
    settings: { keyPrefixes: ['DEV'] },
  })
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    tasks: async (project) => (project === PLATFORM_SLUG ? [task] : []),
    task: async () => null,
    pointer: async () => null,
  }
  await setContextItem({
    task: task.key,
    id: 'next',
    kind: 'next-action',
    source: 'workflow-next',
    body: 'Land the pull request.',
  })
  await setContextItem({
    task: task.key,
    id: 'open-q1',
    kind: 'open-question',
    source: 'q1',
    body: 'Did the pull request land?',
  })
  const payload = {
    project: PLATFORM_SLUG,
    target: '314',
    prNumber: 314,
    headBranch: 'feature/DEV-2270-context',
    headCommit: 'head-commit',
    mergeCommit: '0123456789abcdef',
    requiredRungs: [],
    rungDecisionError: null,
    releaseRequired: false,
    depth: null,
    promoteWorkflowDrafts: false,
    recordingError: null,
    requeueOutput: null,
  }

  const exitCode = await runPullRequestPostLandingCommand('314', writableDb(), {
    readPayload: async () => encodePullRequestPostLandingPayload(payload),
    runPostLanding: async () => {
      throw new Error('cleanup failed')
    },
    log: () => {},
  })

  expect(exitCode).toBe(POST_LANDING_REPORTED_EXIT_CODE)
  expect((await getContext({ task: task.key })).items).toEqual([
    expect.objectContaining({
      id: 'next',
      source: 'pr-merge',
      body: 'PR 314 landed as 0123456789ab.',
    }),
  ])
})
