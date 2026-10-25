import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { adoptSessionRuns, formatSessionAdoption } from './session-adopt.ts'

const machine = '00000000-0000-4000-8000-000000000001'
const chain = JSON.stringify([
  { pid: 987_654, startTime: 'transient-start' },
  { pid: 987_655, startTime: 'owner-start' },
])

function seen(session: string, lastSeen: string, ancestorChain: string | null = chain): void {
  db()
    .query('INSERT INTO session_seen(session_id,last_seen,ancestor_chain) VALUES (?,?,?)')
    .run(session, lastSeen, ancestorChain)
}

test('adopts roots and held turns, audits each root, and enqueues terminal members', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'former' })
  const turn = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    session: 'former',
    parent: root,
    turn: 2,
  })
  db().query("UPDATE run SET launch_key='DEV-1722' WHERE record_id=?").run(root)
  seen('former', '2026-10-24T00:00:00.000Z')
  const probed: number[] = []

  const report = adoptSessionRuns('former', 'planned handoff', {
    database: db(),
    actor: 'successor',
    now: Date.parse('2026-10-24T02:00:00.000Z'),
    probe: (pid) => {
      probed.push(pid)
      return { alive: false, startTime: null }
    },
    machine,
  })

  expect(report).toMatchObject({ totalRuns: 1, totalTurns: 2 })
  expect(probed).toEqual([987_654, 987_655])
  expect(report.runs[0]).toMatchObject({
    recordId: root,
    job: 'implement',
    key: 'DEV-1722',
    turns: 2,
  })
  expect(JSON.parse(JSON.stringify(report)).runs[0].recordId).toBe(root)
  expect(formatSessionAdoption(report)).toContain(
    `run ${report.runs[0]!.number} ${root} implement DEV-1722: 2 turn(s)`,
  )
  expect(
    db().query('SELECT session_id FROM run WHERE record_id IN (?,?) ORDER BY turn').all(root, turn),
  ).toEqual([{ session_id: 'successor' }, { session_id: 'successor' }])
  expect(
    db().query("SELECT COUNT(*) count FROM run_mutation_audit WHERE action='adopt'").get(),
  ).toEqual({ count: 1 })
  expect(db().query("SELECT COUNT(*) count FROM outbox WHERE kind='run'").get()).toEqual({
    count: 2,
  })
})

test('refuses self, a live owner, and an unknown recently seen owner', () => {
  expect(() =>
    adoptSessionRuns('same', 'self', { database: db(), actor: 'same', machine }),
  ).toThrow('cannot adopt its own runs')

  seen('live-owner', '2026-10-24T01:30:00.000Z')
  expect(() =>
    adoptSessionRuns('live-owner', 'too soon', {
      database: db(),
      actor: 'successor',
      now: Date.parse('2026-10-24T02:00:00.000Z'),
      probe: (pid) =>
        pid === 987_654
          ? { alive: false, startTime: null }
          : { alive: true, startTime: 'owner-start' },
      machine,
    }),
  ).toThrow('session live-owner is live')

  seen('unknown-owner', '2026-10-24T01:30:00.000Z', null)
  expect(() =>
    adoptSessionRuns('unknown-owner', 'too soon', {
      database: db(),
      actor: 'successor',
      now: Date.parse('2026-10-24T02:00:00.000Z'),
      probe: () => ({ alive: false, startTime: null }),
      machine,
    }),
  ).toThrow('wait until last_seen is older than the session live window')
})
