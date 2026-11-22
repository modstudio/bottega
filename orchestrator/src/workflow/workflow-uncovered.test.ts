import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import {
  CANON_MIRROR_JOB,
  HOOK_TREE_JOB,
  ISSUE_BEFORE_TREE_JOB,
  LANDING_TREE_JOB,
  SYSTEM_LIFECYCLE_JOBS,
} from '../run/synthetic-lifecycle-job.ts'
import {
  decideWorkflowUncovered,
  LIFECYCLE_TREE_COVER_WINDOW_MS,
  workflowUncoveredCommand,
  workflowUncoveredReport,
} from './workflow-uncovered.ts'

const evidence = [
  { project: 'alpha', key: 'DEV-1', at: '2026-11-17T10:00:00.000Z', source: 'run' as const },
  {
    project: 'alpha',
    key: 'DEV-2',
    at: '2026-11-17T11:00:00.000Z',
    source: 'landing' as const,
  },
  { project: 'alpha', key: 'DEV-3', at: '2026-11-17T12:00:00.000Z', source: 'run' as const },
  { project: 'alpha', key: 'DEV-3', at: '2026-11-17T13:00:00.000Z', source: 'run' as const },
]

test('reports each uncovered task once per day and includes zero days', () => {
  expect(
    decideWorkflowUncovered({
      days: 2,
      now: '2026-11-17T20:00:00.000Z',
      evidence,
      cursors: [
        {
          project: 'alpha',
          key: 'DEV-1',
          openedAt: '2026-11-17T09:00:00.000Z',
          closedAt: '2026-11-17T10:30:00.000Z',
        },
      ],
      claims: [
        {
          project: 'alpha',
          key: 'DEV-2',
          openedAt: '2026-11-17T10:30:00.000Z',
          closedAt: '2026-11-17T11:30:00.000Z',
        },
      ],
      cursorlessRuns: [
        {
          number: 42,
          job: 'understand',
          session: 'session-a',
          at: '2026-11-17T14:00:00.000Z',
          probe: false,
        },
      ],
      failedBeforeClaimRuns: [{ day: '2026-11-17', count: 2 }],
    }),
  ).toEqual({
    expected: 0,
    days: [
      {
        day: '2026-11-16',
        count: 0,
        tasks: [],
        cursorlessRuns: [],
        probeRuns: [],
        failedBeforeClaim: 0,
      },
      {
        day: '2026-11-17',
        count: 1,
        tasks: [{ project: 'alpha', key: 'DEV-3' }],
        cursorlessRuns: [{ number: 42, job: 'understand', session: 'session-a' }],
        probeRuns: [],
        failedBeforeClaim: 2,
      },
    ],
  })
})

test('evidence after a cursor closes or a claim lapses is uncovered', () => {
  const coverage = {
    project: 'alpha',
    key: 'DEV-1',
    openedAt: '2026-11-17T08:00:00.000Z',
    closedAt: '2026-11-17T09:00:00.000Z',
  }
  const report = decideWorkflowUncovered({
    days: 1,
    now: '2026-11-17T20:00:00.000Z',
    evidence: [evidence[0]!],
    cursors: [coverage],
    claims: [coverage],
  })
  expect(report.days[0]).toEqual({
    day: '2026-11-17',
    count: 1,
    tasks: [{ project: 'alpha', key: 'DEV-1' }],
    cursorlessRuns: [],
    probeRuns: [],
    failedBeforeClaim: 0,
  })
})

test('canon mirror run evidence is exempt by job only', () => {
  expect(SYSTEM_LIFECYCLE_JOBS).toEqual([CANON_MIRROR_JOB])
  const report = decideWorkflowUncovered({
    days: 1,
    now: '2026-11-17T20:00:00.000Z',
    evidence: [
      { ...evidence[0]!, job: CANON_MIRROR_JOB },
      { ...evidence[0]!, key: 'DEV-2', job: 'implement' },
    ],
    cursors: [],
    claims: [],
  })
  expect(report.days[0]!.tasks).toEqual([{ project: 'alpha', key: 'DEV-2' }])
})

test('branch-matched lifecycle tree cursors opening inside the window cover earlier rows', () => {
  const cursors = [
    {
      project: 'alpha',
      key: 'DEV-1',
      branch: 'DEV-1-change',
      openedAt: '2026-11-17T10:00:09.000Z',
      closedAt: null,
    },
    {
      project: 'alpha',
      key: 'DEV-2',
      branch: 'DEV-2-change',
      openedAt: '2026-11-17T10:00:25.000Z',
      closedAt: null,
    },
  ]
  const report = decideWorkflowUncovered({
    days: 1,
    now: '2026-11-17T20:00:00.000Z',
    evidence: [
      { ...evidence[0]!, job: LANDING_TREE_JOB, branch: ' DEV-1-change ' },
      { ...evidence[0]!, key: 'DEV-2', job: HOOK_TREE_JOB, branch: 'DEV-2-change' },
    ],
    cursors,
    claims: [],
  })
  expect(report.days[0]!.tasks).toEqual([])
})

test('lifecycle tree binding rejects other jobs, mismatched or absent branches, and late cursors', () => {
  const at = '2026-11-17T10:00:00.000Z'
  const cursor = (
    key: string,
    branch?: string,
    openedAt = '2026-11-17T10:00:09.000Z',
    closedAt: string | null = null,
  ) => ({ project: 'alpha', key, ...(branch ? { branch } : {}), openedAt, closedAt })
  const report = decideWorkflowUncovered({
    days: 1,
    now: '2026-11-17T20:00:00.000Z',
    evidence: [
      { project: 'alpha', key: 'DEV-1', at, source: 'run', job: 'implement', branch: 'one' },
      {
        project: 'alpha',
        key: 'DEV-2',
        at,
        source: 'run',
        job: ISSUE_BEFORE_TREE_JOB,
        branch: 'two',
      },
      { project: 'alpha', key: 'DEV-3', at, source: 'run', job: LANDING_TREE_JOB, branch: 'three' },
      { project: 'alpha', key: 'DEV-4', at, source: 'run', job: LANDING_TREE_JOB, branch: 'four' },
      { project: 'alpha', key: 'DEV-5', at, source: 'run', job: LANDING_TREE_JOB, branch: 'five' },
      { project: 'alpha', key: 'DEV-6', at, source: 'run', job: LANDING_TREE_JOB, branch: 'six' },
    ],
    cursors: [
      cursor('DEV-1', 'one'),
      cursor('DEV-2', 'two'),
      cursor('DEV-3', 'different'),
      cursor(
        'DEV-4',
        'four',
        new Date(Date.parse(at) + LIFECYCLE_TREE_COVER_WINDOW_MS + 1).toISOString(),
      ),
      cursor('DEV-5'),
      cursor('DEV-6', 'six', '2026-11-17T09:59:58.000Z', '2026-11-17T09:59:59.000Z'),
    ],
    claims: [],
  })
  expect(report.days[0]!.tasks.map((task) => task.key)).toEqual([
    'DEV-1',
    'DEV-2',
    'DEV-3',
    'DEV-4',
    'DEV-5',
    'DEV-6',
  ])
})

test('handoff coverage requires one live claim spanning the old close and successor open', () => {
  const handoff = {
    project: 'alpha',
    key: 'DEV-1',
    closedAt: '2026-11-17T10:00:00.000Z',
    openedAt: '2026-11-17T10:00:00.000Z',
  }
  const base = {
    days: 1,
    now: '2026-11-17T20:00:00.000Z',
    evidence: [],
    cursors: [],
    handoffs: [handoff],
  }
  expect(
    decideWorkflowUncovered({
      ...base,
      claims: [
        { project: 'alpha', key: 'DEV-1', openedAt: '2026-11-17T09:00:00.000Z', closedAt: null },
      ],
    }).days[0]!.count,
  ).toBe(0)
  expect(decideWorkflowUncovered({ ...base, claims: [] }).days[0]).toEqual({
    day: '2026-11-17',
    count: 1,
    tasks: [{ project: 'alpha', key: 'DEV-1' }],
    cursorlessRuns: [],
    probeRuns: [],
    failedBeforeClaim: 0,
  })
})

test('separates probe runs from counted cursorless runs for the same day', () => {
  const report = decideWorkflowUncovered({
    days: 1,
    now: '2026-11-17T20:00:00.000Z',
    evidence: [],
    cursors: [],
    claims: [],
    cursorlessRuns: [
      {
        number: 43,
        job: 'implement',
        session: 'session-b',
        at: '2026-11-17T15:00:00.000Z',
        probe: true,
      },
      {
        number: 42,
        job: 'understand',
        session: 'session-a',
        at: '2026-11-17T14:00:00.000Z',
        probe: false,
      },
    ],
  })

  expect(report.days[0]!.cursorlessRuns).toEqual([
    { number: 42, job: 'understand', session: 'session-a' },
  ])
  expect(report.days[0]!.probeRuns).toEqual([
    { number: 43, job: 'implement', session: 'session-b' },
  ])
})

test('rejects an invalid day window', () => {
  expect(() =>
    decideWorkflowUncovered({
      days: 0,
      now: '2026-11-17T20:00:00.000Z',
      evidence: [],
      cursors: [],
      claims: [],
    }),
  ).toThrow('--days must be a positive integer')
})

test('the command lists cursorless runs and sets failure or success explicitly', async () => {
  const output = (lines: string[], codes: number[]) => ({
    log: (line: string) => lines.push(line),
    setExitCode: (code: number) => codes.push(code),
  })
  const gapLines: string[] = []
  const gapCodes: number[] = []
  await workflowUncoveredCommand({}, output(gapLines, gapCodes), async () => ({
    expected: 0,
    days: [
      {
        day: '2026-11-17',
        count: 0,
        tasks: [],
        cursorlessRuns: [{ number: 42, job: 'understand', session: 'session-a' }],
        probeRuns: [],
        failedBeforeClaim: 3,
      },
    ],
  }))
  expect(gapLines).toEqual([
    '2026-11-17: 0 (expected 0)',
    '  cursorless runs: 1 (expected 0)  #42 understand',
    '  probe runs: 0',
    '  failed before claim: 3',
  ])
  expect(gapCodes).toEqual([1])

  const clearCodes: number[] = []
  await workflowUncoveredCommand({}, output([], clearCodes), async () => ({
    expected: 0,
    days: [
      {
        day: '2026-11-17',
        count: 0,
        tasks: [],
        cursorlessRuns: [],
        probeRuns: [],
        failedBeforeClaim: 4,
      },
    ],
  }))
  expect(clearCodes).toEqual([0])
})

test('the command lists probe runs without failing', async () => {
  const lines: string[] = []
  const codes: number[] = []
  await workflowUncoveredCommand(
    {},
    {
      log: (line) => lines.push(line),
      setExitCode: (code) => codes.push(code),
    },
    async () => ({
      expected: 0,
      days: [
        {
          day: '2026-11-17',
          count: 0,
          tasks: [],
          cursorlessRuns: [],
          probeRuns: [{ number: 43, job: 'implement', session: 'session-b' }],
          failedBeforeClaim: 0,
        },
      ],
    }),
  )

  expect(lines).toContain('  probe runs: 1  #43 implement')
  expect(codes).toEqual([0])
})

test('the adapter correlates run and landing evidence with hosted-shaped cursor and claim reads', async () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE project (
      record_id TEXT PRIMARY KEY,name TEXT,path TEXT,stack TEXT,canon INTEGER,settings TEXT,retired_at TEXT
    );
    CREATE TABLE run (
      number INTEGER,project_record_id TEXT,launch_key TEXT,started_at TEXT,branch TEXT,
      minted_branch TEXT,job TEXT,session_id TEXT,cursor_record_id TEXT,turn INTEGER,
      agent TEXT,status TEXT,probe INTEGER
    );
    CREATE TABLE branch_landing_record (
      project TEXT,project_record_id TEXT,branch TEXT,merged_at TEXT
    );
    INSERT INTO project VALUES
      ('project-alpha','alpha','/projects/alpha',NULL,1,'{"keyPrefixes":["DEV"]}',NULL);
    INSERT INTO run VALUES
      (1,'project-alpha','DEV-1','2026-11-17T10:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1,'codex','ok',0),
      (2,'project-alpha','DEV-2','2026-11-17T10:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1,'codex','ok',0),
      (3,'project-alpha','DEV-3','2026-11-17T10:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1,'codex','ok',0),
      (4,'project-alpha',NULL,'2026-11-17T13:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1,'codex','ok',0),
      (5,'project-alpha',NULL,'2026-11-17T14:00:00.000Z',NULL,NULL,'hook-tree','session-a',NULL,1,'codex','ok',0),
      (6,'project-alpha',NULL,'2026-11-17T15:00:00.000Z',NULL,NULL,'understand','session-a','cursor-a',1,'codex','ok',0),
      (7,'project-alpha',NULL,'2026-11-17T16:00:00.000Z',NULL,NULL,'understand','session-a',NULL,2,'codex','ok',0),
      (8,'project-alpha',NULL,'2026-11-17T17:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1,'(pending)','failed',0),
      (9,'project-alpha',NULL,'2026-11-17T18:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1,'codex','failed',0),
      (10,'project-alpha',NULL,'2026-11-17T19:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1,'(pending)','ok',0),
      (11,'project-alpha',NULL,'2026-11-17T19:30:00.000Z',NULL,NULL,'implement','session-b',NULL,1,'codex','ok',1);
    INSERT INTO branch_landing_record VALUES
      ('alpha','project-alpha','DEV-4-change','2026-11-17T12:00:00.000Z');
  `)
  try {
    const cursorRows = [
      {
        record_id: 'cursor-dev-2',
        project: 'alpha',
        workflow_key: 'DEV-2',
        created_at: '2026-11-17T09:00:00.000Z',
        state: 'running',
        updated_at: '2026-11-17T09:00:00.000Z',
        handed_off_from_record_id: null,
      },
      {
        record_id: 'cursor-dev-5-old',
        project: 'alpha',
        workflow_key: 'DEV-5',
        created_at: '2026-11-17T08:00:00.000Z',
        state: 'done',
        updated_at: '2026-11-17T10:00:00.000Z',
        handed_off_from_record_id: null,
      },
      {
        record_id: 'cursor-dev-5-new',
        project: 'alpha',
        workflow_key: 'DEV-5',
        created_at: '2026-11-17T10:00:00.000Z',
        state: 'running',
        updated_at: '2026-11-17T10:00:00.000Z',
        handed_off_from_record_id: 'cursor-dev-5-old',
      },
    ] as never
    const report = (spanHandoff: boolean) =>
      workflowUncoveredReport(
        {
          days: 1,
          database,
          clock: Date.parse('2026-11-17T20:00:00.000Z'),
        },
        {
          taskFlowStore: {
            keyedStageHistory: async () => cursorRows,
          },
          claimList: async () => ({
            claims: [
              {
                recordId: 'claim-dev-3',
                project: 'alpha',
                subject: { kind: 'task', value: 'DEV-3' },
                holder: 'session-a',
                note: null,
                runId: null,
                run_record_id: null,
                takenAt: '2026-11-17T09:00:00.000Z',
                renewedAt: '2026-11-17T09:00:00.000Z',
                lapsesAt: '2026-11-17T11:00:00.000Z',
                live: false,
                closedAt: null,
                closeReason: null,
                previousClaimRecordIds: [],
                supersededByClaimRecordId: null,
              },
              ...(spanHandoff
                ? [
                    {
                      recordId: 'claim-dev-5',
                      project: 'alpha',
                      subject: { kind: 'task' as const, value: 'DEV-5' },
                      holder: 'session-a',
                      note: null,
                      runId: null,
                      run_record_id: null,
                      takenAt: '2026-11-17T09:00:00.000Z',
                      renewedAt: '2026-11-17T10:00:00.000Z',
                      lapsesAt: '2026-11-17T11:00:00.000Z',
                      live: true,
                      closedAt: null,
                      closeReason: null,
                      previousClaimRecordIds: [],
                      supersededByClaimRecordId: null,
                    },
                  ]
                : []),
            ],
          }),
        },
      )
    expect((await report(false)).days[0]).toEqual({
      day: '2026-11-17',
      count: 3,
      tasks: [
        { project: 'alpha', key: 'DEV-1' },
        { project: 'alpha', key: 'DEV-4' },
        { project: 'alpha', key: 'DEV-5' },
      ],
      cursorlessRuns: [
        { number: 4, job: 'understand', session: 'session-a' },
        { number: 9, job: 'understand', session: 'session-a' },
        { number: 10, job: 'understand', session: 'session-a' },
      ],
      probeRuns: [{ number: 11, job: 'implement', session: 'session-b' }],
      failedBeforeClaim: 1,
    })
    expect((await report(true)).days[0]).toEqual({
      day: '2026-11-17',
      count: 2,
      tasks: [
        { project: 'alpha', key: 'DEV-1' },
        { project: 'alpha', key: 'DEV-4' },
      ],
      cursorlessRuns: [
        { number: 4, job: 'understand', session: 'session-a' },
        { number: 9, job: 'understand', session: 'session-a' },
        { number: 10, job: 'understand', session: 'session-a' },
      ],
      probeRuns: [{ number: 11, job: 'implement', session: 'session-b' }],
      failedBeforeClaim: 1,
    })
  } finally {
    database.close()
  }
})
