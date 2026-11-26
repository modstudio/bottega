import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { job } from '../jobs/jobs.ts'
import { resolveLens } from '../lens/lenses.ts'
import { upsertProject } from '../project/projects.ts'
import { sha } from '../run/prompt-sha.ts'
import { detach as detachRun } from '../run/run-dispatch.ts'
import { SPEC_UNSETTLED_QUESTION } from '../typed-question/spec-unsettled-question.ts'
import {
  composeDispatchPrompt,
  dispatchCommand,
  genericLensProfileNotices,
  lensDispatchNotices,
  reviewDetachFields,
  reviewMemoryBranch,
  reviewRoleForDispatch,
  validateContinueBranchOptions,
  warnForUnsettledSpec,
} from './dispatch-commands.ts'
import { harnessCursorAdapter } from './keyed-run-cursor-admission-adapter.ts'

/** Give each test in the enclosing describe its own harness session, restoring the caller's value afterwards. */
function harnessSessionHooks(prefix: string): { session: string } {
  const state = { session: '' }
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.CLAUDE_CODE_SESSION_ID
    state.session = `${prefix}-${newRecordId()}`
    process.env.CLAUDE_CODE_SESSION_ID = state.session
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = saved
  })
  return state
}

describe('a keyed run-start dispatch under a held cursor writes its current step binding', () => {
  const harness = harnessSessionHooks('cursor-session')
  test('a keyed run-start dispatch under a held cursor writes its current step binding', async () => {
    const project = `cursor-binding-${newRecordId()}`
    const projectId = newRecordId()
    const cursorRecordId = newRecordId()
    const harnessSession = harness.session
    upsertProject({ recordId: projectId, name: project, path: import.meta.dir })
    db().exec('PRAGMA foreign_keys=OFF')
    db()
      .query(
        `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
         session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
         closed,total_steps,created_at,updated_at,revision)
       VALUES (?,77123,?,?,'fix-defect','default','DEV-2496','',?, ?,?,'{}',3,'implement-fix',
               'running','[]',7,'2026-11-20','2026-11-20',1)`,
      )
      .run(cursorRecordId, project, projectId, harnessSession, newRecordId(), newRecordId())
    db().exec('PRAGMA foreign_keys=ON')
    const spawnCoordinator = (() => {
      const child = new EventEmitter() as EventEmitter & { pid: number; unref(): void }
      child.pid = process.pid
      child.unref = () => {}
      queueMicrotask(() => child.emit('spawn'))
      return child
    }) as never
    let runId: string | null = null
    try {
      await dispatchCommand(
        ['do', 'understand'],
        {
          has: (name) => ['key', 'porcelain'].includes(name),
          flag: (name) => (name === 'key' ? 'DEV-2496' : name === 'repo' ? project : undefined),
          values: () => [],
        },
        {
          usage: () => {
            throw new Error('unexpected usage')
          },
          doUsage: () => {
            throw new Error('unexpected do usage')
          },
          error: () => {},
          readPrompt: async () => 'Read the current implementation.',
          askTypedQuestion: async () => null,
          specIdentity: () => 'binding-test',
          validateSchema: () => {},
          warnCallerDrift: () => {},
          warnTaskBranchBypass: () => {},
          resolveTaskBranchForDispatch: async () => null,
          checkoutHasUncommittedWork: () => false,
          resolveBase: (_cwd, base) => base,
          isWorktreeRelativeRef: () => false,
          implicitReviewWarning: () => 'unused',
          resolveReviewTarget: () => null,
          resolveCallerCheckout: () => ({
            callerCwd: import.meta.dir,
            launchCwd: import.meta.dir,
            notice: null,
          }),
          resolveDispatchOptions: async () => ({
            agent: 'harness',
            agentExplicit: true,
            transport: 'cli',
            transportExplicit: false,
            avoid: [],
            distinctModels: [],
            mcp: undefined,
            agentHarness: null,
          }),
          harnessCursorAdapter,
          lookupTaskKey: async () => ({ state: 'found' }),
          recordRunWarning: () => {},
          earlierReviewRejections: noEarlierReviewRejections,
          reviewLensInputs: noLensInputs,
          detach: async (jobName, prompt, _wait, spec) => {
            runId = await detachRun(jobName, prompt, spec, 'harness', spawnCoordinator)
            return runId
          },
          follow: async () => {},
          runNumber: () => 1,
          detachedResult: () => {},
        },
      )
      expect(runId).not.toBeNull()
      expect(
        db().query('SELECT cursor_record_id,step_slug FROM run WHERE record_id=?').get(runId!),
      ).toEqual({ cursor_record_id: cursorRecordId, step_slug: 'implement-fix' })
    } finally {
      if (runId) db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(runId)
    }
  })
})

test('an unbound keyed harness dispatch refuses before detach', async () => {
  const project = `cursor-admission-${newRecordId()}`
  upsertProject({ recordId: newRecordId(), name: project, path: import.meta.dir })
  let detached = false

  await expect(
    dispatchCommand(
      ['do', 'implement'],
      {
        has: (name) => name === 'key',
        flag: (name) => (name === 'key' ? 'DEV-2293' : name === 'repo' ? project : undefined),
        values: () => [],
      },
      {
        resolveDispatchOptions: async () => ({
          agent: undefined,
          agentExplicit: false,
          transport: 'cli',
          transportExplicit: false,
          avoid: [],
          distinctModels: [],
          mcp: undefined,
          agentHarness: null,
        }),
        resolveCallerCheckout: () => ({
          callerCwd: '/tmp',
          launchCwd: '/tmp',
          notice: null,
        }),
        harnessCursorAdapter: () => ({
          harnessSession: 'session-fixture',
          overridePersonName: null,
          readOpenCursors: async () => [],
        }),
        detach: async () => {
          detached = true
          return newRecordId()
        },
      } as never,
    ),
  ).rejects.toThrow('harness session session-fixture does not hold an open workflow cursor')

  expect(detached).toBe(false)
})

describe('an unkeyed dispatch refuses writing work and binds non-writing work to its keyless cursor', () => {
  const harness = harnessSessionHooks('keyless-cursor-session')
  test('an unkeyed dispatch refuses writing work and binds non-writing work to its keyless cursor', async () => {
    const project = `keyless-cursor-admission-${newRecordId()}`
    const projectId = newRecordId()
    const harnessSession = harness.session
    upsertProject({ recordId: projectId, name: project, path: import.meta.dir })
    const cursorRecordId = newRecordId()
    db().exec('PRAGMA foreign_keys=OFF')
    db()
      .query(
        `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
         session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
         closed,total_steps,created_at,updated_at,revision)
       VALUES (?,77124,?,?,'explore','default','','',?, ?,?,'{}',1,'explore',
               'running','[]',1,'2026-11-21','2026-11-21',1)`,
      )
      .run(cursorRecordId, project, projectId, harnessSession, newRecordId(), newRecordId())
    db().exec('PRAGMA foreign_keys=ON')
    const detached: Array<{ jobName: string; binding: unknown }> = []
    const flags = {
      has: (name: string) => name === 'porcelain',
      flag: (name: string) => (name === 'repo' ? project : undefined),
      values: () => [],
    }
    const presentation = {
      usage: () => {
        throw new Error('unexpected usage')
      },
      doUsage: () => {
        throw new Error('unexpected do usage')
      },
      error: () => {},
      readPrompt: async () => 'Inspect the current implementation.',
      askTypedQuestion: async () => null,
      specIdentity: () => 'keyless-dispatch-test',
      validateSchema: () => {},
      warnCallerDrift: () => {},
      warnTaskBranchBypass: () => {},
      resolveTaskBranchForDispatch: async () => null,
      checkoutHasUncommittedWork: () => false,
      resolveBase: (_cwd: string, base: string) => base,
      isWorktreeRelativeRef: () => false,
      implicitReviewWarning: () => 'unused',
      resolveReviewTarget: () => null,
      resolveCallerCheckout: () => ({
        callerCwd: import.meta.dir,
        launchCwd: import.meta.dir,
        notice: null,
      }),
      resolveDispatchOptions: async () => ({
        agent: 'harness',
        agentExplicit: true,
        transport: 'cli' as const,
        transportExplicit: false,
        avoid: [],
        distinctModels: [],
        mcp: undefined,
        agentHarness: null,
      }),
      harnessCursorAdapter,
      lookupTaskKey: async () => ({ state: 'found' as const }),
      recordRunWarning: () => {},
      earlierReviewRejections: noEarlierReviewRejections,
      reviewLensInputs: noLensInputs,
      detach: async (
        jobName: string,
        _prompt: string,
        _wait: boolean,
        spec: { binding?: unknown },
      ) => {
        detached.push({ jobName, binding: spec.binding })
        return newRecordId()
      },
      follow: async () => {},
      runNumber: () => 1,
      detachedResult: () => {},
    }

    await expect(
      dispatchCommand(['do', 'implement'], flags, presentation as never),
    ).rejects.toThrow('has no task key and this job writes the repository')
    expect(detached).toEqual([])

    await dispatchCommand(['do', 'understand'], flags, presentation as never)
    expect(detached).toEqual([
      {
        jobName: 'understand',
        binding: { cursorRecordId, stepSlug: 'explore' },
      },
    ])
  })
})

test('an attributed unbound override detaches and records its warning on the run', async () => {
  const project = `cursor-override-${newRecordId()}`
  upsertProject({ recordId: newRecordId(), name: project, path: import.meta.dir })
  const runId = newRecordId()
  const detached: string[] = []
  const warnings: Array<{ runId: string; warning: string }> = []

  await dispatchCommand(
    ['do', 'understand'],
    {
      has: (name) => ['key', 'from-operator', 'porcelain'].includes(name),
      flag: (name) =>
        name === 'key'
          ? 'DEV-2293'
          : name === 'repo'
            ? project
            : name === 'override-unbound'
              ? 'Emergency dispatch approved.'
              : undefined,
      values: () => [],
    },
    {
      usage: () => {
        throw new Error('unexpected usage')
      },
      doUsage: () => {
        throw new Error('unexpected do usage')
      },
      error: () => {},
      readPrompt: async () => 'Survey this task.',
      askTypedQuestion: async () => null,
      specIdentity: () => 'spec-fixture',
      validateSchema: () => {},
      warnCallerDrift: () => {},
      warnTaskBranchBypass: () => {},
      resolveTaskBranchForDispatch: async () => null,
      checkoutHasUncommittedWork: () => false,
      resolveBase: (_cwd, base) => base,
      isWorktreeRelativeRef: () => false,
      implicitReviewWarning: () => 'unused',
      resolveReviewTarget: () => null,
      resolveCallerCheckout: () => ({
        callerCwd: import.meta.dir,
        launchCwd: import.meta.dir,
        notice: null,
      }),
      resolveDispatchOptions: async () => ({
        agent: undefined,
        agentExplicit: false,
        transport: 'cli',
        transportExplicit: false,
        avoid: [],
        distinctModels: [],
        mcp: undefined,
        agentHarness: null,
      }),
      harnessCursorAdapter: () => ({
        harnessSession: 'session-fixture',
        overridePersonName: 'Dana Example',
        readOpenCursors: async () => [],
      }),
      lookupTaskKey: async () => ({ state: 'found' }),
      recordRunWarning: (recordedRunId, warning) =>
        warnings.push({ runId: recordedRunId, warning }),
      earlierReviewRejections: noEarlierReviewRejections,
      reviewLensInputs: noLensInputs,
      detach: async () => {
        detached.push(runId)
        return runId
      },
      follow: async () => {},
      runNumber: () => 1,
      detachedResult: () => {},
    },
  )

  expect(detached).toEqual([runId])
  expect(warnings).toEqual([
    {
      runId,
      warning: 'unbound run turn overridden by Dana Example: Emergency dispatch approved.',
    },
  ])
})

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
