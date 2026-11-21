import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  decideFloorSatisfaction,
  type Floor,
  type FloorSatisfactionInput,
} from './workflow-floor.ts'
import { dispatchObligationRefusal } from './workflow-run-obligation.ts'
import {
  gatherEarlierStepWorkflowRunChains,
  gatherLandedEarlierStepWorkflowRunChains,
  gatherWorkflowRunChains,
} from './workflow-run-obligation-evidence.ts'

const floor = (kind: Floor['kind']): Floor => ({
  kind,
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
})
const tracker = floor('tracker-transition')
const artifact = floor('recorded-artifact')
const dispatchStep = { slug: 'start', jobs: ['implement'], dispatch: 'required' as const }
const terminalDispatch = { number: 41, job: 'implement', terminal: true, needsVerdict: false }
const closedTask = {
  task: {
    key: 'DEV-1',
    status: 'done',
    statusCategory: 'done',
    mergedPullRequest: false,
    trackerStates: {},
  },
}
const decide = (input: Partial<FloorSatisfactionInput> & Pick<FloorSatisfactionInput, 'floors'>) =>
  decideFloorSatisfaction({
    evidence: {},
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
    ...input,
  })

test.each([
  ['zero runs', [], 'no implement run was dispatched'],
  ['a running chain', [{ ...terminalDispatch, terminal: false }], 'run 41 is not terminal'],
  [
    'an unscored terminal chain',
    [{ ...terminalDispatch, needsVerdict: true }],
    'run 41 still needs a verdict',
  ],
] as const)('a required dispatch refuses %s', (_name, dispatchRuns, message) => {
  const decision = decide({
    floors: [tracker],
    evidence: { ...closedTask, dispatchRuns: [...dispatchRuns] },
    workflowKey: 'DEV-1',
    step: dispatchStep,
  })
  expect(decision).toMatchObject({ action: 'refuse' })
  if (decision.action === 'refuse') expect(decision.message).toContain(message)
})

test('a terminal scored dispatch allows', () => {
  expect(
    decide({
      floors: [tracker],
      evidence: { ...closedTask, dispatchRuns: [terminalDispatch] },
      workflowKey: 'DEV-1',
      step: dispatchStep,
    }).action,
  ).toBe('allow')
})

test('a current-step chain is credited without mentioning an earlier chain', () => {
  expect(
    dispatchObligationRefusal({
      workflowKey: 'DEV-1',
      cursorNumber: 1214,
      selectedFloors: [],
      metWaiverFacts: [],
      step: {
        ...dispatchStep,
        slug: 'apply-findings',
        dispatchWaivedBy: ['no-accepted-findings'],
      },
      dispatchRuns: [terminalDispatch],
      earlierStepRuns: [{ number: 987_654, stepSlug: 'blast-radius' }],
    }),
  ).toBeNull()
})

test('empty earlier-step evidence keeps the existing zero-dispatch wording', () => {
  const refusal = dispatchObligationRefusal({
    workflowKey: 'DEV-1',
    cursorNumber: 1214,
    selectedFloors: [],
    metWaiverFacts: [],
    step: {
      ...dispatchStep,
      slug: 'apply-findings',
      dispatchWaivedBy: ['no-accepted-findings'],
    },
    dispatchRuns: [],
    earlierStepRuns: [],
  })

  expect(refusal).toBe(
    `dispatch obligation is unmet: no implement run was dispatched from this cursor at step apply-findings; dispatch one with \`${PLATFORM_SLUG} run start implement --key DEV-1 ...\` from this cursor`,
  )
})

test('earlier-step evidence keeps the existing wording outside apply-findings', () => {
  const refusal = dispatchObligationRefusal({
    workflowKey: 'DEV-1',
    cursorNumber: 1214,
    selectedFloors: [],
    metWaiverFacts: [],
    step: {
      slug: 'review-lenses',
      jobs: ['review-lens'],
      dispatch: 'required',
      dispatchWaivedBy: ['no-lens-owed'],
    },
    dispatchRuns: [],
    earlierStepRuns: [{ number: 987_654, stepSlug: 'blast-radius' }],
  })

  expect(refusal).toBe(
    `dispatch obligation is unmet: no review-lens run was dispatched from this cursor at step review-lenses; dispatch one with \`${PLATFORM_SLUG} run start review-lens --key DEV-1 ...\` from this cursor`,
  )
})

test('run-chain evidence includes only the requested cursor and step', () => {
  const cursorRecordId = newRecordId()
  const otherCursorRecordId = newRecordId()
  const matching = addRun({ agent: 'codex', job: 'implement' })
  const otherStep = addRun({ agent: 'codex', job: 'implement' })
  const otherCursor = addRun({ agent: 'codex', job: 'implement' })
  const bind = db().query('UPDATE run SET cursor_record_id=?,step_slug=? WHERE record_id=?')
  bind.run(cursorRecordId, 'start', matching)
  bind.run(cursorRecordId, 'implement-fix', otherStep)
  bind.run(otherCursorRecordId, 'start', otherCursor)
  const matchingNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(matching)!.number

  expect(gatherWorkflowRunChains(cursorRecordId, ['implement'], db(), 'start')).toEqual([
    expect.objectContaining({ number: matchingNumber, job: 'implement' }),
  ])
})

test('a plain continuation turn bound to this cursor after activation is credited', () => {
  const cursorRecordId = newRecordId()
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    startedAt: '2026-11-19T00:00:00.000Z',
  })
  const turn = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: root,
    turn: 2,
    startedAt: '2026-11-19T02:00:00.000Z',
  })
  const bind = db().query('UPDATE run SET cursor_record_id=?,step_slug=? WHERE record_id=?')
  bind.run(cursorRecordId, 'blast-radius', root)
  bind.run(cursorRecordId, 'blast-radius', turn)
  score(root, 'full', 'right', 'faithful')

  const dispatchRuns = gatherWorkflowRunChains(
    cursorRecordId,
    ['implement'],
    db(),
    'apply-findings',
    '2026-11-19T01:00:00.000Z',
  )
  expect(dispatchRuns).toEqual([
    expect.objectContaining({ job: 'implement', terminal: true, needsVerdict: false }),
  ])
  expect(
    gatherEarlierStepWorkflowRunChains(
      cursorRecordId,
      ['implement'],
      'apply-findings',
      '2026-11-19T01:00:00.000Z',
      db(),
    ),
  ).toEqual([])
  expect(
    decide({
      floors: [tracker],
      evidence: { ...closedTask, dispatchRuns },
      workflowKey: 'DEV-1',
      step: {
        ...dispatchStep,
        slug: 'apply-findings',
        dispatchWaivedBy: ['no-accepted-findings'],
      },
    }).action,
  ).toBe('allow')
})

test('a landed earlier-step chain satisfies apply-findings', () => {
  expect(
    dispatchObligationRefusal({
      workflowKey: 'DEV-1',
      cursorNumber: 1214,
      selectedFloors: [],
      metWaiverFacts: [],
      step: {
        ...dispatchStep,
        slug: 'apply-findings',
        dispatchWaivedBy: ['no-accepted-findings'],
      },
      dispatchRuns: [],
      earlierStepRuns: [{ number: 987_654, stepSlug: 'blast-radius' }],
      landedEarlierStepRuns: [{ number: 987_654, stepSlug: 'blast-radius', prNumber: 2252 }],
    }),
  ).toBeNull()
})

test('a landed earlier-step chain is read from its newest turn branch', () => {
  const root = addRun({ agent: 'codex', job: 'implement' })
  const turn = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
  const projectRecordId = db()
    .query<{ project_record_id: string }, [string]>(
      'SELECT project_record_id FROM run WHERE record_id=?',
    )
    .get(root)!.project_record_id
  db()
    .query('UPDATE run SET branch=?,branch_kept=? WHERE record_id=?')
    .run(null, 'DEV-1-landed', turn)
  db()
    .query(
      `INSERT INTO branch_landing_record
        (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
       VALUES (?,'run-fixture',?,'DEV-1-landed','tip',2252,'merge','2026-11-19','2026-11-19')`,
    )
    .run(newRecordId(), projectRecordId)
  const number = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(root)!.number

  expect(
    gatherLandedEarlierStepWorkflowRunChains([{ number, stepSlug: 'blast-radius' }], db()),
  ).toEqual([{ number, stepSlug: 'blast-radius', prNumber: 2252 }])
})

test('an unlanded earlier-step chain keeps the confirmation-turn remedy', () => {
  const refusal = dispatchObligationRefusal({
    workflowKey: 'DEV-1',
    cursorNumber: 1214,
    selectedFloors: [],
    metWaiverFacts: [],
    step: {
      ...dispatchStep,
      slug: 'apply-findings',
      dispatchWaivedBy: ['no-accepted-findings'],
    },
    dispatchRuns: [],
    earlierStepRuns: [{ number: 987_654, stepSlug: 'blast-radius' }],
    landedEarlierStepRuns: [],
  })

  expect(refusal).toContain(
    'A finding applied before triage needs a confirmation turn at this step',
  )
  expect(refusal).toContain(
    `${PLATFORM_SLUG} run continue --findings --cursor 1214 987654 "<message>"`,
  )
})

test('a landed earlier-step chain gets no credit outside apply-findings', () => {
  expect(
    dispatchObligationRefusal({
      workflowKey: 'DEV-1',
      cursorNumber: 1214,
      selectedFloors: [],
      metWaiverFacts: [],
      step: { ...dispatchStep, slug: 'verify-fix' },
      dispatchRuns: [],
      earlierStepRuns: [{ number: 987_654, stepSlug: 'blast-radius' }],
      landedEarlierStepRuns: [{ number: 987_654, stepSlug: 'blast-radius', prNumber: 2252 }],
    }),
  ).toContain('no implement run was dispatched from this cursor at step verify-fix')
})

test('earlier-step evidence excludes a turn started after current-step activation', () => {
  const cursorRecordId = newRecordId()
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    startedAt: '2026-11-19T02:00:00.000Z',
  })
  db()
    .query('UPDATE run SET cursor_record_id=?,step_slug=? WHERE record_id=?')
    .run(cursorRecordId, 'blast-radius', root)

  expect(
    gatherEarlierStepWorkflowRunChains(
      cursorRecordId,
      ['implement'],
      'apply-findings',
      '2026-11-19T01:00:00.000Z',
      db(),
    ),
  ).toEqual([])
})

test('a turn bound at another step before activation is not credited', () => {
  const cursorRecordId = newRecordId()
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    startedAt: '2026-11-19T00:00:00.000Z',
  })
  db()
    .query('UPDATE run SET cursor_record_id=?,step_slug=? WHERE record_id=?')
    .run(cursorRecordId, 'blast-radius', root)

  expect(
    gatherWorkflowRunChains(
      cursorRecordId,
      ['implement'],
      db(),
      'apply-findings',
      '2026-11-19T01:00:00.000Z',
    ),
  ).toEqual([])
})

test('a turn bound to another cursor after activation is not credited', () => {
  const cursorRecordId = newRecordId()
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    startedAt: '2026-11-19T00:00:00.000Z',
  })
  const turn = addRun({
    agent: 'codex',
    job: 'implement',
    parent: root,
    turn: 2,
    startedAt: '2026-11-19T02:00:00.000Z',
  })
  const bind = db().query('UPDATE run SET cursor_record_id=?,step_slug=? WHERE record_id=?')
  bind.run(cursorRecordId, 'blast-radius', root)
  bind.run(newRecordId(), 'blast-radius', turn)

  expect(
    gatherWorkflowRunChains(
      cursorRecordId,
      ['implement'],
      db(),
      'apply-findings',
      '2026-11-19T01:00:00.000Z',
    ),
  ).toEqual([])
})

test('a root that is ok while its latest turn runs refuses the bound step', () => {
  const cursorRecordId = newRecordId()
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const turn = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    parent: root,
    turn: 2,
  })
  db()
    .query('UPDATE run SET cursor_record_id=?,step_slug=? WHERE record_id=?')
    .run(cursorRecordId, 'apply-findings', turn)
  const dispatchRuns = gatherWorkflowRunChains(
    cursorRecordId,
    ['implement'],
    db(),
    'apply-findings',
  )

  expect(dispatchRuns).toEqual([
    expect.objectContaining({ job: 'implement', terminal: false, needsVerdict: false }),
  ])
  expect(
    decide({
      floors: [tracker],
      evidence: { ...closedTask, dispatchRuns },
      workflowKey: 'DEV-1',
      step: { ...dispatchStep, slug: 'apply-findings' },
    }).action,
  ).toBe('refuse')
})

test('a terminal unscored review lens satisfies its dispatch step', () => {
  expect(
    decide({
      floors: [artifact],
      evidence: {
        artifacts: [{ artifact: { ref: 'probe:3', exists: true } }],
        dispatchRuns: [{ number: 51, job: 'review-lens', terminal: true, needsVerdict: true }],
      },
      workflowKey: 'DEV-1',
      step: { slug: 'review-lenses', jobs: ['review-lens'], dispatch: 'required' },
    }).action,
  ).toBe('allow')
})

test('a judging step refuses an unscored lens chain', () => {
  const decision = decide({
    floors: [],
    evidence: {
      judgedRuns: [{ number: 51, job: 'review-lens', terminal: true, needsVerdict: true }],
    },
    workflowKey: 'DEV-1',
    step: { slug: 'triage-findings', jobs: [], judges: ['review-lens'] },
  })
  expect(decision).toMatchObject({ action: 'refuse' })
  if (decision.action === 'refuse') expect(decision.message).toContain(`${PLATFORM_SLUG} score 51`)
})

test.each([
  ['review-lenses', 'no-lens-owed'],
  ['apply-findings', 'no-accepted-findings'],
] as const)('a true %s waiver fact allows zero dispatches', (slug, fact) => {
  expect(
    decide({
      floors: [artifact],
      evidence: {
        artifacts: [{ artifact: { ref: 'probe:3', exists: true } }],
        metDispatchWaiverFacts: [fact],
      },
      workflowKey: 'DEV-1',
      step: { ...dispatchStep, slug, dispatchWaivedBy: [fact] },
    }).action,
  ).toBe('allow')
})

test.each([
  ['review-lenses', 'no-lens-owed'],
  ['apply-findings', 'no-accepted-findings'],
] as const)('a false %s waiver fact refuses zero dispatches', (slug, fact) => {
  expect(
    decide({
      floors: [artifact],
      evidence: { artifacts: [{ artifact: { ref: 'probe:3', exists: true } }] },
      workflowKey: 'DEV-1',
      step: { ...dispatchStep, slug, dispatchWaivedBy: [fact] },
    }).action,
  ).toBe('refuse')
})

test('a selected descendants-closed floor allows zero dispatches', () => {
  expect(
    decide({
      floors: [floor('descendants-closed')],
      evidence: { ...closedTask, descendants: [] },
      workflowKey: 'DEV-1',
      step: dispatchStep,
    }).action,
  ).toBe('allow')
})
