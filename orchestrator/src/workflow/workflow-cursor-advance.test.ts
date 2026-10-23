import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import {
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
  nextWorkflowStep,
} from './workflow-cursor.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const context = { session: 'flow-session' }
const args = { key: 'DEV-1422' }
const testPorts = {
  readTask: (key: string) => ({
    key,
    status: 'done' as const,
    statusCategory: 'done' as const,
    commentIds: [],
  }),
  runHasArtifacts: () => true,
  resolveCheckout: () => ({ project: 'fixture', branch: 'work', headIsTipOrAncestor: true }),
  viewPullRequest: () => ({
    state: 'MERGED',
    mergedAt: '2026-10-20',
    headRefName: 'work',
    baseRefName: 'main',
    url: 'https://github.com/acme/app/pull/1',
  }),
  resolveTreeCommit: () => 'abc',
}

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    newRecordId(),
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
})

function installConditionalFixture(
  d: Database,
  slug: string,
  conditionalSteps: string[],
  tail: string[] = ['complete'],
): void {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: [
        ...current.steps,
        {
          slug: 'flow-choice',
          title: 'Choose the flow',
          stage: 'review',
          body: 'Choose the recorded outcome.',
          floor: ['recorded-artifact'],
          outcomes: ['needed', 'clear'],
          job: null,
          autonomy: 'auto',
          needs: [],
        },
      ],
    },
    'conditional cursor fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'publish', 'test', d)
  const draft = setWorkflowLocal(
    slug,
    {
      title: 'Conditional fixture',
      description: 'Exercises conditional cursor flow.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: [
            'flow-choice',
            ...conditionalSteps.map((step) => ({
              step,
              when: { step: 'flow-choice', outcome: ['needed'] },
            })),
            ...tail,
          ],
        },
      ],
    },
    'conditional cursor fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'publish', 'test', d)
}

function closeChoice(d: Database, slug: string, outcome?: string): string {
  const probe = d
    .query<{ id: number }, [string]>(
      `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at)
       VALUES (?,'["true"]','/tmp','abc',0,'','2026-10-20') RETURNING id`,
    )
    .get(newRecordId())!.id
  return nextWorkflowStep(
    slug,
    'fixture',
    'default',
    args,
    'selected',
    context,
    d,
    { artifact: `probe:${probe}` },
    testPorts,
    undefined,
    undefined,
    outcome,
  )
}

function open(d: Database, slug: string): void {
  composeWorkflowWithCursor(slug, 'fixture', 'default', args, context, d)
}

describe('conditional workflow cursor advance', () => {
  test('a step declaring outcomes refuses a close without one', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-required', ['score'])
    open(d, 'conditional-required')
    expect(() => closeChoice(d, 'conditional-required')).toThrow(
      'requires --outcome <slug>; allowed values: needed, clear',
    )
  })

  test('an unmet condition records a skip and serves the next eligible step', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-skip', ['score'])
    open(d, 'conditional-skip')
    expect(closeChoice(d, 'conditional-skip', 'clear')).toContain(
      'Flow so far: flow-choice=clear, score=skipped',
    )
    const row = d.query('SELECT ordinal,step_slug,closed FROM workflow_cursor').get() as {
      ordinal: number
      step_slug: string
      closed: string
    }
    expect(row).toMatchObject({ ordinal: 2, step_slug: 'complete' })
    expect(JSON.parse(row.closed)).toEqual([
      expect.objectContaining({ slug: 'flow-choice', outcome: 'clear' }),
      expect.objectContaining({
        slug: 'score',
        skipped: { step: 'flow-choice', outcome: ['needed'] },
      }),
    ])
    expect(
      getWorkflowStepWithCursor('conditional-skip', 'fixture', 'score', args, 'default', context, d)
        .slug,
    ).toBe('complete')
  })

  test('a met condition serves the conditional step', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-met', ['score'])
    open(d, 'conditional-met')
    expect(closeChoice(d, 'conditional-met', 'needed')).toContain('Score every lens.')
    expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
      ordinal: 1,
      step_slug: 'score',
    })
  })

  test('a chain of two unmet conditions skips both', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-chain', ['score', 'ship-triage'])
    open(d, 'conditional-chain')
    closeChoice(d, 'conditional-chain', 'clear')
    const row = d.query('SELECT ordinal,step_slug,closed FROM workflow_cursor').get() as {
      ordinal: number
      step_slug: string
      closed: string
    }
    expect(row).toMatchObject({ ordinal: 3, step_slug: 'complete' })
    expect(
      JSON.parse(row.closed).filter((entry: { skipped?: unknown }) => entry.skipped),
    ).toHaveLength(2)
  })

  test('skipping conditional steps off the end finishes the cursor', () => {
    const d = database()
    installConditionalFixture(d, 'conditional-end', ['score'], [])
    open(d, 'conditional-end')
    expect(closeChoice(d, 'conditional-end', 'clear')).toContain('is finished: 2 steps closed')
    expect(d.query('SELECT state FROM workflow_cursor').get()).toEqual({ state: 'done' })
  })
})

const flowStep = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  title: slug,
  stage: 'review' as const,
  body: `${slug} body.`,
  floor: ['recorded-artifact'],
  job: null,
  autonomy: 'auto' as const,
  needs: [],
  ...extra,
})

function installFlowFixture(
  d: Database,
  slug: string,
  extraSteps: ReturnType<typeof flowStep>[],
  modeSteps: Array<string | { step: string; when: { step: string; outcome: string[] } }>,
): void {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    { ...current, steps: [...current.steps, ...extraSteps] },
    'flow-state cursor fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'publish', 'test', d)
  const draft = setWorkflowLocal(
    slug,
    {
      title: 'Flow-state fixture',
      description: 'Exercises ruling outcomes and re-entry.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: modeSteps }],
    },
    'flow-state cursor fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'publish', 'test', d)
}

function closeStep(
  d: Database,
  slug: string,
  outcome: string | undefined,
  ruling?: number,
  extra: { review?: string } = {},
): string {
  const probe = d
    .query<{ id: number }, [string]>(
      `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at)
       VALUES (?,'["true"]','/tmp','abc',0,'','2026-10-20') RETURNING id`,
    )
    .get(newRecordId())!.id
  return nextWorkflowStep(
    slug,
    'fixture',
    'default',
    args,
    'selected',
    context,
    d,
    { artifact: `probe:${probe}`, ...(ruling === undefined ? {} : { ruling }), ...extra },
    testPorts,
    undefined,
    undefined,
    outcome,
  )
}

function boundRuling(d: Database, answeredAt = new Date(Date.now() + 1000).toISOString()): number {
  const row = d
    .query<{ id: number; ordinal: number; step_slug: string; workflow_key: string }, []>(
      'SELECT id,ordinal,step_slug,workflow_key FROM workflow_cursor',
    )
    .get()!
  return d
    .query<{ number: number }, (string | number | null)[]>(
      `INSERT INTO question
        (number,record_id,workflow_cursor_id,workflow_key,asked_at,question,asked_via,answered_at,answer,
         workflow_step_ordinal,workflow_step_slug)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?,?,'workflow',?,'yes',?,?)
       RETURNING number`,
    )
    .get(
      newRecordId(),
      row.id,
      row.workflow_key,
      answeredAt,
      'floor ruling?',
      answeredAt,
      row.ordinal + 1,
      row.step_slug,
    )!.number
}

function setLastReentryAt(d: Database, at: string): void {
  const row = d.query<{ closed: string }, []>('SELECT closed FROM workflow_cursor').get()!
  const closed = JSON.parse(row.closed) as Array<{ reentered?: unknown; at: string }>
  const last = closed.findLast((entry) => entry.reentered)
  if (!last) throw new Error('expected a re-entry close')
  last.at = at
  d.query('UPDATE workflow_cursor SET closed=?').run(JSON.stringify(closed))
}

function insertGradedReview(d: Database): string {
  const project = (
    d
      .query<{ id: string }, [string]>('SELECT record_id AS id FROM project WHERE name=?')
      .get('fixture') as { id: string }
  ).id
  const key = (
    d.query<{ workflow_key: string }, []>('SELECT workflow_key FROM workflow_cursor').get() as {
      workflow_key: string
    }
  ).workflow_key
  const runId = d
    .query<{ id: string }, (string | number | null)[]>(
      `INSERT INTO run (record_id,number,started_at,agent,job,repo,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,exit_code,launch_key,branch,session_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-10-20','codex','implement','fixture',?,'sha',1,'p','ok',0,?,null,?)
       RETURNING record_id AS id`,
    )
    .get(newRecordId(), project, key, context.session)!.id
  const reviewId = newRecordId()
  d.query(
    `INSERT INTO review (record_id,number,recorded_at,project_record_id)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),'2026-10-20',?)`,
  ).run(reviewId, project)
  d.query(
    `INSERT INTO review_lens (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(newRecordId(), reviewId, runId)
  return String(
    (
      d
        .query<{ number: number }, [string]>('SELECT number FROM review WHERE record_id=?')
        .get(reviewId) as { number: number }
    ).number,
  )
}

describe('ruling outcomes and bounded re-entry', () => {
  test('a mixed command-exit step refuses a failed exec and closes on a successful exec', () => {
    const d = database()
    installFlowFixture(
      d,
      'command-close',
      [flowStep('command', { floor: ['command-exit', 'recorded-artifact'] })],
      ['command'],
    )
    open(d, 'command-close')
    const recordExec = (exitCode: number) =>
      d
        .query<{ id: number }, (string | number)[]>(
          `INSERT INTO probe
            (record_id,command,cwd,head_commit,exit_code,output_tail,session_id,created_at,kind)
           VALUES (?,?,'/tmp','abc',?,'','flow-session','9999-01-01','exec') RETURNING id`,
        )
        .get(newRecordId(), JSON.stringify([PLATFORM_SLUG, 'pr', 'create']), exitCode)!.id
    const close = (id: number) =>
      nextWorkflowStep(
        'command-close',
        'fixture',
        'default',
        args,
        'opened pull request',
        context,
        d,
        { artifact: `exec:${id}` },
        testPorts,
      )

    const failed = recordExec(1)
    expect(() => close(failed)).toThrow(
      `command-exit floor expects exit code 0, but evidence exec:${failed} command \`${PLATFORM_SLUG} pr create\` exited 1; close with the outcome configured for exit code 1, or record a command that exits 0 with \`${PLATFORM_SLUG} workflow exec -- <command>\` and pass the new exec id`,
    )
    expect(close(recordExec(0))).toContain('is finished: 1 steps closed')
  })

  test('a command-exit step applies the exit code declared for the chosen outcome', () => {
    const install = (d: Database, slug: string) => {
      installFlowFixture(
        d,
        slug,
        [
          flowStep('merge-pr', {
            floor: ['command-exit', 'recorded-artifact'],
            outcomes: ['merged', 'merged-with-residue'],
            expectedExitCodes: { merged: 0, 'merged-with-residue': 20 },
          }),
        ],
        ['merge-pr'],
      )
      open(d, slug)
    }
    const recordExec = (d: Database, exitCode: number) =>
      d
        .query<{ id: number }, (string | number)[]>(
          `INSERT INTO probe
            (record_id,command,cwd,head_commit,exit_code,output_tail,session_id,created_at,kind)
           VALUES (?,?,'/tmp','abc',?,'','flow-session','9999-01-01','exec') RETURNING id`,
        )
        .get(newRecordId(), JSON.stringify([PLATFORM_SLUG, 'pr', 'merge']), exitCode)!.id
    const close = (d: Database, slug: string, id: number, outcome: string) =>
      nextWorkflowStep(
        slug,
        'fixture',
        'default',
        args,
        'merged pull request',
        context,
        d,
        { artifact: `exec:${id}` },
        testPorts,
        undefined,
        undefined,
        outcome,
      )

    const residue = database()
    install(residue, 'merge-residue')
    const exit20 = recordExec(residue, 20)
    expect(() => close(residue, 'merge-residue', exit20, 'merged')).toThrow(
      `command-exit floor expects exit code 0, but evidence exec:${exit20}`,
    )
    expect(close(residue, 'merge-residue', exit20, 'merged-with-residue')).toContain(
      'is finished: 1 steps closed',
    )

    for (const outcome of ['merged', 'merged-with-residue']) {
      const failed = database()
      const slug = `merge-failed-${outcome}`
      install(failed, slug)
      const exit1 = recordExec(failed, 1)
      const expected = outcome === 'merged' ? 0 : 20
      expect(() => close(failed, slug, exit1, outcome)).toThrow(
        `command-exit floor expects exit code ${expected}, but evidence exec:${exit1}`,
      )
    }
  })

  test('a ruling outcome refuses without a ruling and closes with one', () => {
    const d = database()
    installFlowFixture(
      d,
      'ruling-outcome',
      [
        flowStep('flow-triage', { outcomes: ['fix', 'clear'], rulingOutcomes: ['fix'] }),
        flowStep('flow-done'),
      ],
      ['flow-triage', 'flow-done'],
    )
    open(d, 'ruling-outcome')
    expect(() => closeStep(d, 'ruling-outcome', 'fix')).toThrow(/floor ruling is unmet/)
    expect(closeStep(d, 'ruling-outcome', 'fix', boundRuling(d))).toContain('flow-done body.')
  })

  test('a non-ruling outcome closes on ordinary floors', () => {
    const d = database()
    installFlowFixture(
      d,
      'ordinary-outcome',
      [
        flowStep('flow-triage', { outcomes: ['fix', 'clear'], rulingOutcomes: ['fix'] }),
        flowStep('flow-done'),
      ],
      ['flow-triage', 'flow-done'],
    )
    open(d, 'ordinary-outcome')
    expect(closeStep(d, 'ordinary-outcome', 'clear')).toContain('flow-done body.')
  })

  test('the first re-entry moves back, records pass 2, and a clean outcome advances', () => {
    const d = database()
    installFlowFixture(
      d,
      'reentry-once',
      [
        flowStep('flow-start'),
        flowStep('flow-apply', {
          outcomes: ['changed', 'clean'],
          reenter: { to: 'flow-start', outcome: 'changed' },
        }),
        flowStep('flow-done'),
      ],
      ['flow-start', 'flow-apply', 'flow-done'],
    )
    open(d, 'reentry-once')
    closeStep(d, 'reentry-once', undefined)
    const first = closeStep(d, 'reentry-once', 'changed')
    expect(first).toContain('Flow so far: Pass 2')
    expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
      ordinal: 0,
      step_slug: 'flow-start',
    })
    const closed = JSON.parse(
      (d.query('SELECT closed FROM workflow_cursor').get() as { closed: string }).closed,
    )
    expect(closed.at(-1)).toMatchObject({
      slug: 'flow-apply',
      outcome: 'changed',
      reentered: { to: 'flow-start', pass: 2 },
    })
    closeStep(d, 'reentry-once', undefined)
    expect(closeStep(d, 'reentry-once', 'clean')).toContain('flow-done body.')
    expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
      ordinal: 2,
      step_slug: 'flow-done',
    })
  })

  test('a second re-entry without a ruling is refused and with a ruling re-enters', () => {
    const d = database()
    installFlowFixture(
      d,
      'reentry-bound',
      [
        flowStep('flow-start'),
        flowStep('flow-apply', {
          outcomes: ['changed', 'clean'],
          reenter: { to: 'flow-start', outcome: 'changed' },
        }),
        flowStep('flow-done'),
      ],
      ['flow-start', 'flow-apply', 'flow-done'],
    )
    open(d, 'reentry-bound')
    closeStep(d, 'reentry-bound', undefined)
    closeStep(d, 'reentry-bound', 'changed')
    closeStep(d, 'reentry-bound', undefined)
    expect(() => closeStep(d, 'reentry-bound', 'changed')).toThrow(
      /automatic re-entry bound is reached/,
    )
    expect(() => closeStep(d, 'reentry-bound', 'changed')).toThrow(/workflow await/)
    expect(() => closeStep(d, 'reentry-bound', 'changed')).toThrow(/non-re-entering outcome/)
    expect(() =>
      closeStep(d, 'reentry-bound', 'changed', undefined, { review: insertGradedReview(d) }),
    ).toThrow(/automatic re-entry bound is reached/)
    setLastReentryAt(d, '2026-01-01T00:00:00.000Z')
    const rulingN = boundRuling(d, '2026-01-01T00:00:01.000Z')
    const second = closeStep(d, 'reentry-bound', 'changed', rulingN)
    expect(second).toContain('Flow so far: Pass 3')
    expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
      ordinal: 0,
      step_slug: 'flow-start',
    })
    closeStep(d, 'reentry-bound', undefined)
    expect(() => closeStep(d, 'reentry-bound', 'changed', rulingN)).toThrow(
      /automatic re-entry bound is reached/,
    )
    const third = closeStep(d, 'reentry-bound', 'changed', boundRuling(d))
    expect(third).toContain('Flow so far: Pass 4')
    expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
      ordinal: 0,
      step_slug: 'flow-start',
    })
    const closed = JSON.parse(
      (d.query('SELECT closed FROM workflow_cursor').get() as { closed: string }).closed,
    )
    expect(closed.filter((entry: { reentered?: unknown }) => entry.reentered)).toEqual([
      expect.objectContaining({ reentered: { to: 'flow-start', pass: 2 } }),
      expect.objectContaining({ reentered: { to: 'flow-start', pass: 3 } }),
      expect.objectContaining({ reentered: { to: 'flow-start', pass: 4 } }),
    ])
  })
})
