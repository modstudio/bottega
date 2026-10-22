import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { HostLoad } from '../gate-load.ts'
import { loadHostPressureSamples, sampleHostPressure } from './host-pressure-service.ts'

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
