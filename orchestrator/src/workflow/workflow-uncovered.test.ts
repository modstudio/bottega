import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { decideWorkflowUncovered, workflowUncoveredReport } from './workflow-uncovered.ts'

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
    }),
  ).toEqual({
    expected: 0,
    days: [
      { day: '2026-11-16', count: 0, tasks: [] },
      { day: '2026-11-17', count: 1, tasks: [{ project: 'alpha', key: 'DEV-3' }] },
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

test('the adapter correlates run and landing evidence with cursor and claim intervals', () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE project (
      record_id TEXT PRIMARY KEY,name TEXT,path TEXT,stack TEXT,canon INTEGER,settings TEXT,retired_at TEXT
    );
    CREATE TABLE run (
      project_record_id TEXT,launch_key TEXT,started_at TEXT,branch TEXT,minted_branch TEXT
    );
    CREATE TABLE workflow_cursor (
      project TEXT,workflow_key TEXT,created_at TEXT,state TEXT,updated_at TEXT
    );
    CREATE TABLE board_claim (
      project_record_id TEXT,subject_kind TEXT,subject_value TEXT,taken_at TEXT,lapses_at TEXT,closed_at TEXT
    );
    CREATE TABLE branch_landing_record (
      project TEXT,project_record_id TEXT,branch TEXT,merged_at TEXT
    );
    INSERT INTO project VALUES
      ('project-alpha','alpha','/projects/alpha',NULL,1,'{"keyPrefixes":["DEV"]}',NULL);
    INSERT INTO run VALUES
      ('project-alpha','DEV-1','2026-11-17T10:00:00.000Z',NULL,NULL),
      ('project-alpha','DEV-2','2026-11-17T10:00:00.000Z',NULL,NULL),
      ('project-alpha','DEV-3','2026-11-17T10:00:00.000Z',NULL,NULL);
    INSERT INTO workflow_cursor VALUES
      ('alpha','DEV-2','2026-11-17T09:00:00.000Z','running','2026-11-17T09:00:00.000Z');
    INSERT INTO board_claim VALUES
      ('project-alpha','task','DEV-3','2026-11-17T09:00:00.000Z','2026-11-17T11:00:00.000Z',NULL);
    INSERT INTO branch_landing_record VALUES
      ('alpha','project-alpha','DEV-4-change','2026-11-17T12:00:00.000Z');
  `)
  try {
    expect(
      workflowUncoveredReport({
        days: 1,
        database,
        clock: Date.parse('2026-11-17T20:00:00.000Z'),
      }).days[0],
    ).toEqual({
      day: '2026-11-17',
      count: 2,
      tasks: [
        { project: 'alpha', key: 'DEV-1' },
        { project: 'alpha', key: 'DEV-4' },
      ],
    })
  } finally {
    database.close()
  }
})
