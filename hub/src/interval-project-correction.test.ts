import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import type { IntervalEvidence } from './hosted-evidence.ts'
import {
  correctStoredIntervalProjects,
  intervalOwningProject,
} from './interval-project-correction.ts'

beforeEach(resetFixtureStore)

const projects = [
  { name: 'alpha', settings: { keyPrefixes: ['ALP'] } },
  { name: 'beta', settings: { keyPrefixes: ['BET'] } },
]

test('an unregistered interval project follows only a sole task-prefix owner', () => {
  expect(intervalOwningProject('temporary', 'ALP-12', projects)).toBe('alpha')
  expect(intervalOwningProject('temporary', 'OTHER-12', projects)).toBe('temporary')
  expect(
    intervalOwningProject('temporary', 'SHR-12', [
      ...projects,
      { name: 'gamma', settings: { keyPrefixes: ['SHR'] } },
      { name: 'delta', settings: { keyPrefixes: ['SHR'] } },
    ]),
  ).toBe('temporary')
  expect(intervalOwningProject('temporary', null, projects)).toBe('temporary')
})

test('a registered interval project is never changed by its task prefix', () => {
  expect(intervalOwningProject('alpha', 'BET-12', projects)).toBe('alpha')
})

function insertInterval() {
  const row: IntervalEvidence & { id: string } = {
    id: '00000000-0000-4000-8000-000000000001',
    task_key: 'ALP-12',
    project_name: 'temporary',
    source: 'orch',
    agent: null,
    job: null,
    start_at: '2026-10-08T00:00:01.000Z',
    end_at: '2026-10-08T00:00:01.000Z',
    claude_tokens: 0,
    vendor_tokens: 0,
    vendor_cost_usd: null,
    ref: 'orch:1',
    via: null,
    open: 0,
    session_id: null,
    user_id: null,
  }
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO interval
          (record_id,task_key,project,project_record_id,source,agent,job,start_at,end_at,claude_tokens,vendor_tokens,
           vendor_cost_usd,ref,via,open,session_id,user_id)
         VALUES (?,?,?,'project-id',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.task_key,
        row.project_name,
        row.source,
        row.agent,
        row.job,
        row.start_at,
        row.end_at,
        row.claude_tokens,
        row.vendor_tokens,
        row.vendor_cost_usd,
        row.ref,
        row.via,
        row.open,
        row.session_id,
        row.user_id,
      )
  })
}

test('collection correction persists the owner and queues the changed interval', () => {
  insertInterval()
  writeTransaction((conn) => conn.query(`DELETE FROM hosted_outbox`).run())
  correctStoredIntervalProjects([
    { name: 'alpha', settings: { space: 'alpha', keyPrefixes: ['ALP'] } },
  ])
  expect(
    db().query<{ project: string }, []>(`SELECT project FROM interval WHERE ref='orch:1'`).get(),
  ).toEqual({ project: 'alpha' })
  expect(db().query(`SELECT table_name FROM hosted_outbox`).get()).toEqual({
    table_name: 'hub_interval',
  })
})
