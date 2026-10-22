import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { HostLoad } from '../gate-load.ts'
import {
  loadHostPressureSamples,
  sampleHostPressure,
  stampSessionProcessObservation,
} from './host-pressure-service.ts'

const load: HostLoad = {
  gates: 0,
  loadavg: 20,
  ncpu: 16,
  freeMem: 1,
  pressure: 'normal',
  swapUsed: 0,
  swapTotal: 0,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
}

test('an unavailable process table and sampler cost are stored as observed', () => {
  const database = migratedTestDatabase()
  sampleHostPressure(database, load, '2026-10-21T20:00:00.000Z', {
    processes: null,
    error: 'process table unavailable: refused',
    elapsedMs: 12.5,
    cpuMs: 3.25,
  })
  expect(
    database
      .query(
        `SELECT memory_pressure,processes,process_error,observation_elapsed_ms,observation_cpu_ms
         FROM host_pressure_sample`,
      )
      .get(),
  ).toEqual({
    memory_pressure: 'normal',
    processes: null,
    process_error: 'process table unavailable: refused',
    observation_elapsed_ms: 12.5,
    observation_cpu_ms: 3.25,
  })
  expect(loadHostPressureSamples(database, Date.parse('2026-10-21T20:00:01.000Z'))).toMatchObject([
    { processes: null, observationElapsedMs: 12.5, observationCpuMs: 3.25 },
  ])
})

test('session process stamps restart when the prior anchor disappears and do not refresh on failure', () => {
  const database = migratedTestDatabase()
  const firstAt = '2026-10-21T20:00:00.000Z'
  const secondAt = '2026-10-21T20:01:00.000Z'
  const failedAt = '2026-10-21T20:02:00.000Z'
  const identity = (pid: number) => ({ pid, startTime: `birth-${pid}` })
  stampSessionProcessObservation(database, 'session-common', firstAt, [
    identity(501),
    identity(400),
    identity(300),
    identity(1),
  ])
  stampSessionProcessObservation(database, 'session-common', secondAt, [
    identity(502),
    identity(400),
    identity(300),
    identity(1),
  ])
  stampSessionProcessObservation(database, 'session-common', failedAt, undefined)

  expect(
    database
      .query(
        `SELECT ancestor_chain,ancestor_confirmed_at,last_seen
         FROM session_seen WHERE session_id='session-common'`,
      )
      .get(),
  ).toEqual({
    ancestor_chain: JSON.stringify([identity(502), identity(400), identity(300), identity(1)]),
    ancestor_confirmed_at: secondAt,
    last_seen: failedAt,
  })
})

test('a collapsed stored chain recovers when the session moves', () => {
  const database = migratedTestDatabase()
  const identity = (pid: number) => ({ pid, startTime: `birth-${pid}` })
  stampSessionProcessObservation(database, 'resumed', '2026-10-21T20:00:00.000Z', [identity(1)])
  stampSessionProcessObservation(database, 'resumed', '2026-10-21T20:01:00.000Z', [
    identity(701),
    identity(300),
    identity(1),
  ])
  expect(
    database.query("SELECT ancestor_chain FROM session_seen WHERE session_id='resumed'").get(),
  ).toEqual({ ancestor_chain: JSON.stringify([identity(701), identity(300), identity(1)]) })
})
