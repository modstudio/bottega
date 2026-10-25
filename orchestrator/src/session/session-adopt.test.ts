import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { transferRunMutationOwnership } from '../run/run-authority.ts'
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
  expect(report.consent).toBe('standard')
  expect(probed).toEqual([987_654, 987_655])
  expect(report.runs[0]).toMatchObject({
    recordId: root,
    job: 'implement',
    key: 'DEV-1722',
    turns: 2,
  })
  expect(
    db().query('SELECT session_id FROM run WHERE record_id IN (?,?) ORDER BY turn').all(root, turn),
  ).toEqual([{ session_id: 'successor' }, { session_id: 'successor' }])
  expect(db().query("SELECT reason FROM run_mutation_audit WHERE action='adopt'").get()).toEqual({
    reason: 'consent standard: planned handoff',
  })
  expect(db().query("SELECT COUNT(*) count FROM outbox WHERE kind='run'").get()).toEqual({
    count: 2,
  })
})

test('refuses self, a live owner, and unestablished liveness', () => {
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

  expect(() =>
    adoptSessionRuns('unknown-owner', 'too soon', {
      database: db(),
      actor: 'successor',
      now: Date.parse('2026-10-24T02:00:00.000Z'),
      probe: () => ({ alive: false, startTime: null }),
      machine,
    }),
  ).toThrow('session unknown-owner liveness could not be established')
})

test('cut-off adopts only when recent last_seen is the sole reason liveness is unknown', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'cut-off-owner' })
  seen('cut-off-owner', '2026-10-24T01:30:00.000Z')

  const report = adoptSessionRuns('cut-off-owner', 'owner terminal disappeared', {
    database: db(),
    actor: 'successor',
    consent: 'cut-off',
    now: Date.parse('2026-10-24T02:00:00.000Z'),
    probe: () => ({ alive: false, startTime: null }),
    machine,
  })

  expect(report).toMatchObject({ consent: 'cut-off', totalRuns: 1 })
  expect(report.runs[0]?.recordId).toBe(root)
  expect(formatSessionAdoption(report)).toContain('consent: cut-off')
  expect(db().query("SELECT reason FROM run_mutation_audit WHERE action='adopt'").get()).toEqual({
    reason: 'consent cut-off: owner terminal disappeared',
  })
})

test('cut-off refuses a live owner and liveness without established process evidence', () => {
  seen('live-cut-off-owner', '2026-10-24T01:30:00.000Z')
  expect(() =>
    adoptSessionRuns('live-cut-off-owner', 'claimed cut off', {
      database: db(),
      actor: 'successor',
      consent: 'cut-off',
      now: Date.parse('2026-10-24T02:00:00.000Z'),
      probe: () => ({ alive: true, startTime: 'transient-start' }),
      machine,
    }),
  ).toThrow('session live-cut-off-owner is live')

  expect(() =>
    adoptSessionRuns('unseen-cut-off-owner', 'claimed cut off', {
      database: db(),
      actor: 'successor',
      consent: 'cut-off',
      now: Date.parse('2026-10-24T02:00:00.000Z'),
      probe: () => ({ alive: false, startTime: null }),
      machine,
    }),
  ).toThrow('session unseen-cut-off-owner liveness could not be established')

  seen('malformed-cut-off-owner', '2026-10-24T01:30:00.000Z', 'not-json')
  expect(() =>
    adoptSessionRuns('malformed-cut-off-owner', 'claimed cut off', {
      database: db(),
      actor: 'successor',
      consent: 'cut-off',
      now: Date.parse('2026-10-24T02:00:00.000Z'),
      probe: () => ({ alive: false, startTime: null }),
      machine,
    }),
  ).toThrow('session malformed-cut-off-owner liveness could not be established')
})

test('standard consent names when recently seen adoption opens and the cut-off path', () => {
  seen('recent-owner', '2026-10-24T01:30:00.000Z')

  expect(() =>
    adoptSessionRuns('recent-owner', 'ordinary adoption', {
      database: db(),
      actor: 'successor',
      now: Date.parse('2026-10-24T02:00:00.000Z'),
      probe: () => ({ alive: false, startTime: null }),
      machine,
    }),
  ).toThrow('wait until 2026-10-24T02:30:00.000Z, or use --cut-off now')
})

test('reports roots moved before a later transfer failure and roots still owned by the target', () => {
  const first = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'former' })
  const second = addRun({ agent: 'codex', job: 'review', status: 'running', session: 'former' })
  seen('former', '2026-10-24T00:00:00.000Z')
  let transfers = 0

  const report = adoptSessionRuns('former', 'partial handoff', {
    database: db(),
    actor: 'successor',
    now: Date.parse('2026-10-24T02:00:00.000Z'),
    probe: () => ({ alive: false, startTime: null }),
    machine,
    transfer: (...args) => {
      transfers += 1
      if (transfers === 2) throw new Error('injected transfer failure')
      return transferRunMutationOwnership(...args)
    },
  })

  expect(report.runs.map(({ recordId }) => recordId)).toEqual([first])
  expect(report.notMoved).toEqual([
    expect.objectContaining({
      recordId: second,
      reason: 'injected transfer failure',
      currentOwner: 'former',
    }),
  ])
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(first)).toEqual({
    session_id: 'successor',
  })
  expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(second)).toEqual({
    session_id: 'former',
  })
})
