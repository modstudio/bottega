import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import {
  decideWorkflowUncovered,
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
        { number: 42, job: 'understand', session: 'session-a', at: '2026-11-17T14:00:00.000Z' },
      ],
    }),
  ).toEqual({
    expected: 0,
    days: [
      { day: '2026-11-16', count: 0, tasks: [], cursorlessRuns: [] },
      {
        day: '2026-11-17',
        count: 1,
        tasks: [{ project: 'alpha', key: 'DEV-3' }],
        cursorlessRuns: [{ number: 42, job: 'understand', session: 'session-a' }],
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
  })
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
  })
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
      },
    ],
  }))
  expect(gapLines).toEqual([
    '2026-11-17: 0 (expected 0)',
    '  cursorless runs: 1 (expected 0)  #42 understand',
  ])
  expect(gapCodes).toEqual([1])

  const clearCodes: number[] = []
  await workflowUncoveredCommand({}, output([], clearCodes), async () => ({
    expected: 0,
    days: [{ day: '2026-11-17', count: 0, tasks: [], cursorlessRuns: [] }],
  }))
  expect(clearCodes).toEqual([0])
})

test('the adapter correlates run and landing evidence with hosted-shaped cursor and claim reads', async () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE project (
      record_id TEXT PRIMARY KEY,name TEXT,path TEXT,stack TEXT,canon INTEGER,settings TEXT,retired_at TEXT
    );
    CREATE TABLE run (
      number INTEGER,project_record_id TEXT,launch_key TEXT,started_at TEXT,branch TEXT,
      minted_branch TEXT,job TEXT,session_id TEXT,cursor_record_id TEXT,turn INTEGER
    );
    CREATE TABLE branch_landing_record (
      project TEXT,project_record_id TEXT,branch TEXT,merged_at TEXT
    );
    INSERT INTO project VALUES
      ('project-alpha','alpha','/projects/alpha',NULL,1,'{"keyPrefixes":["DEV"]}',NULL);
    INSERT INTO run VALUES
      (1,'project-alpha','DEV-1','2026-11-17T10:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1),
      (2,'project-alpha','DEV-2','2026-11-17T10:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1),
      (3,'project-alpha','DEV-3','2026-11-17T10:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1),
      (4,'project-alpha',NULL,'2026-11-17T13:00:00.000Z',NULL,NULL,'understand','session-a',NULL,1),
      (5,'project-alpha',NULL,'2026-11-17T14:00:00.000Z',NULL,NULL,'hook-tree','session-a',NULL,1),
      (6,'project-alpha',NULL,'2026-11-17T15:00:00.000Z',NULL,NULL,'understand','session-a','cursor-a',1),
      (7,'project-alpha',NULL,'2026-11-17T16:00:00.000Z',NULL,NULL,'understand','session-a',NULL,2);
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
      cursorlessRuns: [{ number: 4, job: 'understand', session: 'session-a' }],
    })
    expect((await report(true)).days[0]).toEqual({
      day: '2026-11-17',
      count: 2,
      tasks: [
        { project: 'alpha', key: 'DEV-1' },
        { project: 'alpha', key: 'DEV-4' },
      ],
      cursorlessRuns: [{ number: 4, job: 'understand', session: 'session-a' }],
    })
  } finally {
    database.close()
  }
})
