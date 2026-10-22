// concern: sustained host-pressure attribution
/** Pure pressure-episode and process-owner decisions over plain sampled values. */

import { type ProcessSample, processDescendsFrom } from '../resources/process-inventory.ts'

export const HOST_PRESSURE_WINDOW_MS = 3 * 60 * 1000
export const HOST_PRESSURE_SAMPLE_INTERVAL_MS = 30_000
export const HOST_PRESSURE_SAMPLE_RETENTION_MS = 15 * 60 * 1000
const HOST_PRESSURE_MIN_CPU_PERCENT = 200
const HOST_PRESSURE_MIN_PROCESS_SHARE = 0.2

if (HOST_PRESSURE_SAMPLE_RETENTION_MS <= HOST_PRESSURE_WINDOW_MS)
  throw new Error('host-pressure sample retention must exceed the sustained-pressure window')

export type PressureSample = {
  sampledAt: number
  loadavg: number
  ncpu: number
  memoryPressure: string
  processes: ProcessSample[] | null
  observationElapsedMs: number
  observationCpuMs: number
}

export type SessionAnchor = {
  sessionId: string
  pid: number
  startTime: string
  project: string | null
}
export type LiveRunAnchor = { number: number; pid: number; project: string }
type ProcessOwner =
  | { kind: 'run'; name: string; project: string }
  | { kind: 'session'; name: string; sessionId: string; project: string | null }
  | { kind: 'outside'; name: string; project: null }

export type PressureAttribution = {
  episodeStartedAt: number
  owner: ProcessOwner
  rootPid: number
  rootCommand: string
  cpu: number
  share: number
  processes: ProcessSample[]
  loadavg: number
  ncpu: number
}

type Candidate = Omit<PressureAttribution, 'episodeStartedAt' | 'loadavg' | 'ncpu'>

function ownerKey(owner: ProcessOwner): string {
  return owner.kind === 'session' ? `session:${owner.sessionId}` : `${owner.kind}:${owner.name}`
}

export function attributeProcessTrees(
  sample: PressureSample,
  sessions: readonly SessionAnchor[],
  runs: readonly LiveRunAnchor[],
): Candidate[] {
  if (!sample.processes) return []
  const parents = new Map(sample.processes.map((process) => [process.pid, process.ppid]))
  const totalCpu = sample.processes.reduce((sum, process) => sum + process.cpu, 0)
  if (totalCpu <= 0) return []
  const assigned = new Set<number>()
  const result: Candidate[] = []
  const add = (rootPid: number, owner: ProcessOwner, processes: ProcessSample[]) => {
    const cpu = processes.reduce((sum, process) => sum + process.cpu, 0)
    if (cpu <= 0) return
    processes.forEach((process) => {
      assigned.add(process.pid)
    })
    result.push({
      owner,
      rootPid,
      rootCommand:
        sample.processes!.find((process) => process.pid === rootPid)?.command ?? 'unknown',
      cpu,
      share: cpu / totalCpu,
      processes,
    })
  }

  for (const run of runs) {
    const processes = sample.processes.filter((process) =>
      processDescendsFrom(process.pid, run.pid, parents),
    )
    add(run.pid, { kind: 'run', name: `run ${run.number}`, project: run.project }, processes)
  }
  for (const session of sessions) {
    if (
      sample.processes.find((process) => process.pid === session.pid)?.startTime !==
      session.startTime
    )
      continue
    const processes = sample.processes.filter(
      (process) =>
        !assigned.has(process.pid) && processDescendsFrom(process.pid, session.pid, parents),
    )
    add(
      session.pid,
      {
        kind: 'session',
        name: `session ${session.sessionId}`,
        sessionId: session.sessionId,
        project: session.project,
      },
      processes,
    )
  }

  const unowned = sample.processes.filter(
    (process) => process.pid !== 1 && !assigned.has(process.pid),
  )
  const unownedPids = new Set(unowned.map((process) => process.pid))
  for (const root of unowned.filter((process) => !unownedPids.has(process.ppid))) {
    const processes = unowned.filter((process) =>
      processDescendsFrom(process.pid, root.pid, parents),
    )
    add(root.pid, { kind: 'outside', name: root.command, project: null }, processes)
  }
  return result.sort((a, b) => b.cpu - a.cpu)
}

function qualifyingCandidates(
  sample: PressureSample,
  sessions: readonly SessionAnchor[],
  runs: readonly LiveRunAnchor[],
): Candidate[] {
  return attributeProcessTrees(sample, sessions, runs).filter(
    (candidate) =>
      candidate.owner.kind !== 'run' &&
      candidate.cpu >= HOST_PRESSURE_MIN_CPU_PERCENT &&
      candidate.share >= HOST_PRESSURE_MIN_PROCESS_SHARE,
  )
}

/** Retune the provisional window and share constants once delivered notices show whether load fell. */
export function decideHostPressure(input: {
  samples: PressureSample[]
  sessions: readonly SessionAnchor[]
  runs: readonly LiveRunAnchor[]
}): PressureAttribution[] {
  const ordered = [...input.samples].sort((a, b) => a.sampledAt - b.sampledAt)
  let start = ordered.length
  while (start > 0 && ordered[start - 1]!.loadavg > ordered[start - 1]!.ncpu) start--
  const episode = ordered.slice(start)
  if (
    episode.length < 2 ||
    episode.at(-1)!.sampledAt - episode[0]!.sampledAt < HOST_PRESSURE_WINDOW_MS ||
    episode.some((sample) => sample.processes === null)
  )
    return []
  const bySample = episode.map((sample) => qualifyingCandidates(sample, input.sessions, input.runs))
  const latest = episode.at(-1)!
  return bySample[0]!
    .filter((candidate) =>
      bySample.every((candidates) =>
        candidates.some(
          (other) =>
            ownerKey(other.owner) === ownerKey(candidate.owner) &&
            other.rootPid === candidate.rootPid,
        ),
      ),
    )
    .map((candidate) => {
      const current = bySample
        .at(-1)!
        .find(
          (other) =>
            ownerKey(other.owner) === ownerKey(candidate.owner) &&
            other.rootPid === candidate.rootPid,
        )!
      return {
        ...current,
        episodeStartedAt: episode[0]!.sampledAt,
        loadavg: latest.loadavg,
        ncpu: latest.ncpu,
      }
    })
}
