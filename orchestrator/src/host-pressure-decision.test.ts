import { expect, test } from 'bun:test'
import { decideHostPressure, HOST_PRESSURE_WINDOW_MS } from './host-pressure-decision.ts'
import type { ProcessSample } from './process-tree.ts'

const busy: ProcessSample[] = [
  { pid: 1, ppid: 0, cpu: 0, command: 'launchd' },
  { pid: 10, ppid: 1, cpu: 10, command: 'harness' },
  { pid: 11, ppid: 10, cpu: 240, command: 'python tune.py' },
]
const sustained = (processes: ProcessSample[] | null = busy) => [
  { sampledAt: 0, loadavg: 17, ncpu: 16, processes },
  { sampledAt: HOST_PRESSURE_WINDOW_MS, loadavg: 18, ncpu: 16, processes },
]

test('sustained session pressure yields one addressed attribution', () => {
  expect(
    decideHostPressure({
      samples: sustained(),
      anchors: new Map([['session', 10]]),
      liveRunPids: [],
    }),
  ).toMatchObject([{ ownerSession: 'session', rootPid: 10 }])
})

test('a single pressure spike yields no attribution', () => {
  expect(
    decideHostPressure({
      samples: [sustained()[0]!],
      anchors: new Map([['session', 10]]),
      liveRunPids: [],
    }),
  ).toEqual([])
})

test('a busy tree under a live orchestrator run yields no attribution', () => {
  expect(
    decideHostPressure({
      samples: sustained(),
      anchors: new Map([['session', 10]]),
      liveRunPids: [11],
    }),
  ).toEqual([])
})

test('an unowned busy tree yields an operator attribution', () => {
  expect(
    decideHostPressure({ samples: sustained(), anchors: new Map(), liveRunPids: [] }),
  ).toMatchObject([{ ownerSession: null, rootPid: 10 }])
})

test('a persisting episode remains one episode attribution', () => {
  const samples = [
    ...sustained(),
    { sampledAt: HOST_PRESSURE_WINDOW_MS + 30_000, loadavg: 19, ncpu: 16, processes: busy },
  ]
  const result = decideHostPressure({
    samples,
    anchors: new Map([['session', 10]]),
    liveRunPids: [],
  })
  expect(result).toHaveLength(1)
  expect(result[0]!.episodeStartedAt).toBe(0)
})

test('an unavailable process table prevents attribution', () => {
  expect(
    decideHostPressure({
      samples: sustained(null),
      anchors: new Map([['session', 10]]),
      liveRunPids: [],
    }),
  ).toEqual([])
})
