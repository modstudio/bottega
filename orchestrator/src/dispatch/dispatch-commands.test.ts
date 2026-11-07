import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { job } from '../jobs/jobs.ts'
import { resolveLens } from '../lens/lenses.ts'
import { sha } from '../run/prompt-sha.ts'
import { SPEC_UNSETTLED_QUESTION } from '../typed-question/spec-unsettled-question.ts'
import {
  composeDispatchPrompt,
  genericLensProfileNotices,
  lensDispatchNotices,
  reviewDetachFields,
  reviewMemoryBranch,
  reviewRoleForDispatch,
  validateContinueBranchOptions,
  warnForUnsettledSpec,
} from './dispatch-commands.ts'

const noEarlierReviewRejections = () => ({
  project: '',
  branch: null,
  branchLineage: [],
  rows: [],
})
const noLensInputs = async () => ({
  taskTextInput: 'unavailable: test has no task' as const,
  rulingsInput: null,
  taskText: '',
  rulings: '',
})

test('findings dispatch leaves the default role to run dispatch unless explicitly supplementary', () => {
  expect(reviewRoleForDispatch(true, false)).toBeUndefined()
  expect(reviewRoleForDispatch(true, true)).toBe('supplementary')
  expect(reviewRoleForDispatch(false, false)).toBeUndefined()
  expect(() => reviewRoleForDispatch(false, true)).toThrow(
    '--supplementary is only valid for findings-producing jobs',
  )
})

test('generic lens resolution names the stack-profile write command', () => {
  const notices = genericLensProfileNotices(resolveLens('correctness', null), 'node')
  expect(notices).toEqual([
    expect.stringContaining(
      `lens correctness uses generic framework body; write the stack profile with: ${PLATFORM_SLUG} review lens profile set correctness --axis framework --name node`,
    ),
  ])
})

test('unknown catalogue lens notice is omitted for the free-form inline job', () => {
  expect(
    lensDispatchNotices({
      jobName: 'review-lens-inline',
      lens: 'project-specific-review',
      resolved: null,
      stack: 'node',
    }),
  ).toEqual([])
})

test('explicit --review target keys memory independently of the caller checkout branch', () => {
  const resolved = { branch: 'DEV-1373-target', commit: 'a'.repeat(40), base: 'b'.repeat(40) }

  expect(reviewMemoryBranch('main', resolved.branch)).toBe('DEV-1373-target')
  expect(reviewMemoryBranch('DEV-1373-caller', null)).toBe('DEV-1373-caller')
})

test('review detach fields carry one resolved target or preserve an unresolved raw ref', () => {
  const resolved = { branch: 'DEV-2031-target', commit: 'a'.repeat(40), base: 'b'.repeat(40) }

  expect(reviewDetachFields('5c156c96b', resolved)).toEqual({
    review: '5c156c96b',
    resolvedReviewTarget: resolved,
  })
  expect(reviewDetachFields('DEV-2031-target', null)).toEqual({
    review: 'DEV-2031-target',
    resolvedReviewTarget: undefined,
  })
})

test('explicit branch continuation is limited to keyed implement and fix without base', () => {
  expect(() =>
    validateContinueBranchOptions('implement', 'DEV-1843-a', 'main', 'DEV-1843'),
  ).toThrow('--continue cannot be combined with --base')
  expect(() =>
    validateContinueBranchOptions('review-lens', 'DEV-1843-a', undefined, 'DEV-1843'),
  ).toThrow('--continue is only valid for the implement and fix jobs')
  expect(() => validateContinueBranchOptions('fix', 'DEV-1843-a', undefined, undefined)).toThrow(
    '--continue requires --key',
  )
})

test.each([
  [0.85, true],
  [0.84, false],
] as const)('unsettled-spec warning at probability %p reports=%p', async (probability, reports) => {
  const warnings: unknown[][] = []
  await warnForUnsettledSpec(
    {
      jobName: 'implement',
      continuation: false,
      spec: 'Choose a reasonable implementation.',
      specIdentity: '0123456789abcdef',
    },
    async (asked) => {
      expect(asked).toMatchObject({
        question: { id: 'spec_unsettled' },
        subjectKind: 'spec:implement',
        subjectRef: '0123456789abcdef',
      })
      if (asked.question.version === 1) {
        expect(asked.state).toBe('Choose a reasonable implementation.')
        return { noul: probability }
      }
      return { noul: 1 }
    },
    (...values) => warnings.push(values),
  )

  expect(warnings).toHaveLength(reports ? 1 : 0)
  if (reports) {
    expect(warnings[0]?.[0]).toBe(
      '! this spec likely leaves a choice unsettled (p=0.85): a worker will probably stop and ask; settle it first or dispatch anyway',
    )
  }
})

test('unsettled-spec warning stays silent on no answer', async () => {
  const warnings: unknown[][] = []
  await warnForUnsettledSpec(
    {
      jobName: 'implement',
      continuation: false,
      spec: 'Complete spec.',
      specIdentity: 'spec-sha',
    },
    async () => null,
    (...values) => warnings.push(values),
  )
  expect(warnings).toEqual([])
})

test('a continuation does not ask', async () => {
  let asks = 0
  await warnForUnsettledSpec(
    { jobName: 'implement', continuation: true, spec: 'spec', specIdentity: 'spec-sha' },
    async () => {
      asks += 1
      return { noul: 1 }
    },
    () => {},
  )
  expect(asks).toBe(0)
})

test('every new job asks only v1 and only implement warns', async () => {
  for (const jobName of ['diagnose', 'implement']) {
    const versions: number[] = []
    const warnings: unknown[][] = []
    await warnForUnsettledSpec(
      { jobName, continuation: false, spec: 'spec', specIdentity: 'spec-sha' },
      async ({ question }) => {
        versions.push(question.version)
        return { noul: 1 }
      },
      (...values) => warnings.push(values),
    )
    expect(versions).toEqual([SPEC_UNSETTLED_QUESTION.version])
    expect(warnings).toHaveLength(jobName === 'implement' ? 1 : 0)
  }
})

test('unsettled-spec evidence uses the composed prompt identity and raw spec state', async () => {
  const rawSpec = '  Implement this behavior.  '
  const asked: Parameters<
    Parameters<typeof composeDispatchPrompt>[0]['presentation']['askTypedQuestion']
  >[0][] = []
  const { prompt } = await composeDispatchPrompt({
    presentation: {
      readPrompt: async () => rawSpec,
      askTypedQuestion: async (input) => {
        asked.push(input)
        return null
      },
      error: () => {},
      specIdentity: sha,
      earlierReviewRejections: noEarlierReviewRejections,
      reviewLensInputs: noLensInputs,
    },
    project: null,
    requested: job('implement'),
    lens: undefined,
    cwd: '/fixture',
    reviewBranch: null,
    jobName: 'implement',
    continuation: false,
  })

  expect(prompt).toBe('Implement this behavior.')
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ subjectRef: sha(prompt), state: rawSpec })
})

test('an empty implementation spec is refused before asking the typed question', async () => {
  let asks = 0
  await expect(
    composeDispatchPrompt({
      presentation: {
        readPrompt: async () => '   ',
        askTypedQuestion: async () => {
          asks += 1
          return null
        },
        error: () => {},
        specIdentity: sha,
        earlierReviewRejections: noEarlierReviewRejections,
        reviewLensInputs: noLensInputs,
      },
      project: null,
      requested: job('implement'),
      lens: undefined,
      cwd: '/fixture',
      reviewBranch: null,
      jobName: 'implement',
      continuation: false,
    }),
  ).rejects.toThrow('empty prompt')
  expect(asks).toBe(0)
})

test('dispatch stops waiting for an answer at the deadline and does not warn', async () => {
  const warnings: unknown[][] = []
  await warnForUnsettledSpec(
    { jobName: 'implement', continuation: false, spec: 'spec', specIdentity: 'spec-sha' },
    () => new Promise<null>(() => {}),
    (...values) => warnings.push(values),
    20,
  )
  expect(warnings).toHaveLength(0)
})
