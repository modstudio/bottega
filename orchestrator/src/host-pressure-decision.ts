// concern: sustained host-pressure attribution
/** Pure pressure-episode decision over stored samples, session anchors, and live runs. */

import { type ProcessSample, processDescendsFrom } from './process-tree.ts'

export const HOST_PRESSURE_WINDOW_MS = 3 * 60 * 1000
const HOST_PRESSURE_MIN_CPU_PERCENT = 200
const HOST_PRESSURE_MIN_PROCESS_SHARE = 0.2

export type PressureSample = {
  sampledAt: number
  loadavg: number
  ncpu: number
  processes: ProcessSample[] | null
}
export type PressureAttribution = {
  episodeStartedAt: number
  ownerSession: string | null
  rootPid: number
  cpu: number
  share: number
  processes: ProcessSample[]
  loadavg: number
  ncpu: number
}

type Candidate = Omit<PressureAttribution, 'episodeStartedAt' | 'loadavg' | 'ncpu'>

function qualifyingCandidates(
  sample: PressureSample,
  anchors: ReadonlyMap<string, number>,
  liveRunPids: readonly number[],
): Candidate[] {
  if (!sample.processes) return []
  const parents = new Map(sample.processes.map((process) => [process.pid, process.ppid]))
  const outsideRuns = sample.processes.filter(
    (process) => !liveRunPids.some((pid) => processDescendsFrom(process.pid, pid, parents)),
  )
  const totalCpu = sample.processes.reduce((sum, process) => sum + process.cpu, 0)
  if (totalCpu <= 0) return []
  const result: Candidate[] = []
  for (const [ownerSession, anchor] of anchors) {
    const processes = outsideRuns.filter((process) =>
      processDescendsFrom(process.pid, anchor, parents),
    )
    const cpu = processes.reduce((sum, process) => sum + process.cpu, 0)
    const share = cpu / totalCpu
    if (cpu >= HOST_PRESSURE_MIN_CPU_PERCENT && share >= HOST_PRESSURE_MIN_PROCESS_SHARE)
      result.push({ ownerSession, rootPid: anchor, cpu, share, processes })
  }

  const owned = new Set(
    outsideRuns
      .filter((process) =>
        [...anchors.values()].some((anchor) => processDescendsFrom(process.pid, anchor, parents)),
      )
      .map((process) => process.pid),
  )
  const unowned = outsideRuns.filter((process) => process.pid !== 1 && !owned.has(process.pid))
  const unownedPids = new Set(unowned.map((process) => process.pid))
  const roots = unowned.filter((process) => !unownedPids.has(process.ppid))
  for (const root of roots) {
    const processes = unowned.filter((process) =>
      processDescendsFrom(process.pid, root.pid, parents),
    )
    const cpu = processes.reduce((sum, process) => sum + process.cpu, 0)
    const share = cpu / totalCpu
    if (cpu >= HOST_PRESSURE_MIN_CPU_PERCENT && share >= HOST_PRESSURE_MIN_PROCESS_SHARE)
      result.push({ ownerSession: null, rootPid: root.pid, cpu, share, processes })
  }
  return result
}

/**
 * Retune the provisional window and share constants once delivered notices show whether load fell.
 */
export function decideHostPressure(input: {
  samples: PressureSample[]
  anchors: ReadonlyMap<string, number>
  liveRunPids: readonly number[]
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
  const bySample = episode.map((sample) =>
    qualifyingCandidates(sample, input.anchors, input.liveRunPids),
  )
  const latest = episode.at(-1)!
  return bySample[0]!
    .filter((candidate) =>
      bySample.every((candidates) =>
        candidates.some(
          (other) =>
            other.ownerSession === candidate.ownerSession && other.rootPid === candidate.rootPid,
        ),
      ),
    )
    .map((candidate) => {
      const current = bySample
        .at(-1)!
        .find(
          (other) =>
            other.ownerSession === candidate.ownerSession && other.rootPid === candidate.rootPid,
        )!
      return {
        ...current,
        episodeStartedAt: episode[0]!.sampledAt,
        loadavg: latest.loadavg,
        ncpu: latest.ncpu,
      }
    })
}
