import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { HostLoad } from '../gate-load.ts'
import { HOST_PRESSURE_WINDOW_MS } from '../host-pressure/host-pressure-decision.ts'
import { sampleHostPressure } from '../host-pressure/host-pressure-service.ts'
import { hostPressureObservation } from './host-pressure-conditions.ts'
import { formatHostPressureLine } from './monitor-commands.ts'

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
const processes = [
  { pid: 1, ppid: 0, cpu: 0, command: 'launchd' },
  { pid: 10, ppid: 1, cpu: 250, command: '/opt/LogiPluginService --daemon' },
]
const observed = { processes, error: null, elapsedMs: 8, cpuMs: 3 }

test('an unowned pressure condition and host line name the process owner', () => {
  const database = migratedTestDatabase()
  const start = Date.parse('2026-10-21T20:00:00.000Z')
  sampleHostPressure(database, load, new Date(start).toISOString(), observed)
  sampleHostPressure(
    database,
    load,
    new Date(start + HOST_PRESSURE_WINDOW_MS).toISOString(),
    observed,
  )
  const result = hostPressureObservation(database, start + HOST_PRESSURE_WINDOW_MS)
  expect(result.conditions).toMatchObject([
    { kind: 'host-pressure', subject: 'process:LogiPluginService' },
  ])
  expect(formatHostPressureLine(result.report)).toContain('LogiPluginService')
})

test('an unavailable latest process table is not reported as no pressure', () => {
  const database = migratedTestDatabase()
  const clock = Date.parse('2026-10-21T20:00:00.000Z')
  sampleHostPressure(database, load, new Date(clock).toISOString(), {
    processes: null,
    error: 'process table unavailable: refused',
    elapsedMs: 2,
    cpuMs: 1,
  })
  const result = hostPressureObservation(database, clock)
  expect(result.report.available).toBeFalse()
  expect(formatHostPressureLine(result.report)).toContain('process attribution unavailable')
})
