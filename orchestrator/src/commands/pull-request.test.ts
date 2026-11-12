import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { fenceStoreAfterCheckoutMove, writableDb } from '../database/db.ts'
import { getContext, setContextItem } from '../doc/context-service.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from '../doc/context-write-adapter.ts'
import { upsertProject } from '../project/projects.ts'
import { POST_LANDING_REPORTED_EXIT_CODE } from '../pull-request/pr-landed-exit-codes.ts'
import { encodePullRequestPostLandingPayload } from '../pull-request/pr-post-landing-payload.ts'
import {
  applyParentPullRequestContextMoment,
  createPullRequestCommand,
  githubArgsWithStdinBody,
  pullRequestCiCommandOutcome,
  register,
  runPullRequestPostLandingCommand,
  validateGithubArguments,
} from './pull-request.ts'

test('PR create refuses a misspelled explicit title before admission', async () => {
  let creates = 0
  const misspelling = ['me', 'ida'].join('')
  const create = () => {
    creates += 1
    return { output: '', overrideId: null }
  }

  await expect(
    createPullRequestCommand(
      ['--title', `DEV-2016 ${misspelling}`],
      { cwd: process.cwd() },
      undefined,
      create,
    ),
  ).rejects.toThrow(`title:\n"${misspelling}"`)
  expect(creates).toBe(0)
})

test('PR create hands GitHub the stdin body it checked', async () => {
  const received: string[][] = []
  const create = (args: string[]) => {
    received.push(args)
    return { output: '', overrideId: null }
  }
  const stdin = spyOn(Bun.stdin, 'text').mockResolvedValue('Checked body.')
  try {
    await createPullRequestCommand(
      ['--title', 'DEV-2016 Title', '--body-file', '-'],
      { cwd: process.cwd() },
      undefined,
      create,
    )
  } finally {
    stdin.mockRestore()
  }
  expect(received).toEqual([['--title', 'DEV-2016 Title', '--body', 'Checked body.']])
})

test('PR create consumes --cwd instead of forwarding it to GitHub', () => {
  const program = new Command()
  register(program)
  const pr = program.commands.find((command) => command.name() === 'pr')!
  const create = pr.commands.find((command) => command.name() === 'create')!

  const parsed = create.parseOptions(['--cwd', '/tmp/DEV-1849-tree', '--title', 'DEV-1849 title'])

  expect(create.opts().cwd).toBe('/tmp/DEV-1849-tree')
  expect(parsed.unknown).toEqual(['--title', 'DEV-1849 title'])
})

test('PR create resolves a relative --cwd before admission', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'pr-create-relative-'))
  try {
    const relativeTree = relative(process.cwd(), tree)
    const program = new Command().exitOverride()
    register(program)

    await expect(
      program.parseAsync(['node', 'orch', 'pr', 'create', '--cwd', relativeTree]),
    ).rejects.toThrow(`cannot resolve a project for ${tree}`)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('PR admission accepts GitHub content arguments', () => {
  expect(() =>
    validateGithubArguments(['--title', 'DEV-977 title', '--body-file', '/tmp/body']),
  ).not.toThrow()
})

test('PR create forwards checked stdin text as an inline body', () => {
  for (const args of [['--body-file', '-'], ['-F', '-'], ['--body-file=-']]) {
    expect(githubArgsWithStdinBody(['--title', 'Title', ...args], 'Checked body.')).toEqual([
      '--title',
      'Title',
      '--body',
      'Checked body.',
    ])
  }
})

test('PR admission refuses caller-controlled target and output modes in every form', () => {
  for (const args of [
    ['--head', 'other'],
    ['--head=other'],
    ['-Hother'],
    ['--base', 'other'],
    ['--base=other'],
    ['-Bother'],
    ['--repo=x/y'],
    ['-Rx/y'],
    ['--web'],
    ['-w'],
    ['--dry-run'],
    ['--recover=value'],
    ['--json=number,url'],
  ]) {
    expect(() => validateGithubArguments(args)).toThrow('refuses')
  }
})

test('an incomplete CI record reports only its error and exits unsuccessfully', () => {
  expect(
    pullRequestCiCommandOutcome({
      prNumber: 42,
      complete: false,
      counts: { ciRuns: 0, reruns: 0, flakeAttributedReruns: 0 },
      error: `CI recording incomplete for PR #42: unavailable; retry: ${PLATFORM_SLUG} pr ci-record 42`,
    }),
  ).toEqual({
    output: null,
    error: `CI recording incomplete for PR #42: unavailable; retry: ${PLATFORM_SLUG} pr ci-record 42`,
    exitCode: 1,
  })
})

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
