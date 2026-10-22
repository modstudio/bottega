import { expect, test } from 'bun:test'
import type { ProcessSample } from '../resources/process-inventory.ts'
import {
  attributeProcessTrees,
  decideHostPressure,
  HOST_PRESSURE_WINDOW_MS,
  type PressureSample,
} from './host-pressure-decision.ts'

const busy: ProcessSample[] = [
  { pid: 1, ppid: 0, cpu: 0, command: 'launchd' },
  { pid: 10, ppid: 1, cpu: 10, command: 'harness' },
  { pid: 11, ppid: 10, cpu: 240, command: 'python tune.py' },
]
const sample = (sampledAt: number, processes: ProcessSample[] | null = busy): PressureSample => ({
  sampledAt,
  loadavg: 17,
  ncpu: 16,
  memoryPressure: 'normal',
  processes,
  observationElapsedMs: 4,
  observationCpuMs: 2,
})
const sustained = (processes: ProcessSample[] | null = busy) => [
  sample(0, processes),
  sample(HOST_PRESSURE_WINDOW_MS, processes),
]
const session = [{ sessionId: 'session', pid: 10, project: 'alpha' }]

test('sustained session pressure yields one addressed attribution with its project', () => {
  expect(decideHostPressure({ samples: sustained(), sessions: session, runs: [] })).toMatchObject([
    { owner: { kind: 'session', sessionId: 'session', project: 'alpha' }, rootPid: 10 },
  ])
})

test('a single pressure spike yields no attribution', () => {
  expect(decideHostPressure({ samples: [sample(0)], sessions: session, runs: [] })).toEqual([])
})

test('a span one sample interval short of the window yields no episode', () => {
  expect(
    decideHostPressure({
      samples: [sample(0), sample(HOST_PRESSURE_WINDOW_MS - 30_000)],
      sessions: session,
      runs: [],
    }),
  ).toEqual([])
})

test('a run-owned tree is attributed to its run and yields no notice', () => {
  const runs = [{ number: 42, pid: 11, project: 'alpha' }]
  expect(attributeProcessTrees(sample(0), session, runs)[0]).toMatchObject({
    owner: { kind: 'run', name: 'run 42', project: 'alpha' },
    rootPid: 11,
  })
  expect(decideHostPressure({ samples: sustained(), sessions: session, runs })).toEqual([])
})

test('an unowned busy tree yields an operator attribution named by command', () => {
  expect(decideHostPressure({ samples: sustained(), sessions: [], runs: [] })).toMatchObject([
    { owner: { kind: 'outside', name: 'harness' }, rootPid: 10, rootCommand: 'harness' },
  ])
})

test('a persisting episode remains one episode attribution', () => {
  const result = decideHostPressure({
    samples: [...sustained(), sample(HOST_PRESSURE_WINDOW_MS + 30_000)],
    sessions: session,
    runs: [],
  })
  expect(result).toHaveLength(1)
  expect(result[0]!.episodeStartedAt).toBe(0)
})

test('an unavailable process table prevents attribution', () => {
  expect(decideHostPressure({ samples: sustained(null), sessions: session, runs: [] })).toEqual([])
})
