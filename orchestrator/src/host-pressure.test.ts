import { expect, test } from 'bun:test'
import { migratedTestDatabase } from './database/test-database.fixture.ts'
import type { HostLoad } from './gate-load.ts'
import { sampleHostPressure } from './host-pressure.ts'

const load: HostLoad = {
  gates: 0,
  loadavg: 20,
  ncpu: 16,
  freeMem: 1,
  pressure: 'unknown',
  swapUsed: 0,
  swapTotal: 0,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
}

test('an unavailable process table is stored as unavailable rather than zero', () => {
  const database = migratedTestDatabase()
  sampleHostPressure(database, load, '2026-10-21T20:00:00.000Z', {
    processes: null,
    error: 'process table unavailable: refused',
  })
  expect(database.query('SELECT processes,process_error FROM host_pressure_sample').get()).toEqual({
    processes: null,
    process_error: 'process table unavailable: refused',
  })
})
