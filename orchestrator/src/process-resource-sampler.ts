// concern: process-resource-sampler
/** One process-table observation shared by every live run. */

export type ProcessSample = {
  pid: number
  ppid: number
  pgid: number
  cpu: number
  state: string
  rssBytes?: number
  cpuMs?: number
}

export type RunResourceUsage = {
  cpuMs: number
  peakRssBytes: number
  samples: number
  source: 'sampled'
}

const RESOURCE_SAMPLE_INTERVAL_MS = 1_000

function parseCpuTime(value: string): number | null {
  const dayParts = value.split('-')
  if (dayParts.length > 2) return null
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0
  const clock = dayParts.at(-1)!.split(':').map(Number)
  if (!Number.isInteger(days) || days < 0 || clock.some((part) => !Number.isFinite(part)))
    return null
  let seconds: number
  if (clock.length === 3) seconds = clock[0]! * 3_600 + clock[1]! * 60 + clock[2]!
  else if (clock.length === 2) seconds = clock[0]! * 60 + clock[1]!
  else return null
  return (days * 86_400 + seconds) * 1_000
}

export function parseProcessSnapshot(text: string): ProcessSample[] {
  const samples: ProcessSample[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 7) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const pgid = Number(parts[2])
    const cpu = Number(parts[3])
    const state = parts[4] ?? ''
    const rssKb = Number(parts[5])
    const cpuMs = parseCpuTime(parts[6]!)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!Number.isInteger(ppid) || ppid < 0) continue
    if (!Number.isInteger(pgid) || pgid <= 0) continue
    if (!Number.isFinite(cpu) || !Number.isFinite(rssKb) || rssKb < 0 || cpuMs === null) continue
    samples.push({ pid, ppid, pgid, cpu, state, rssBytes: rssKb * 1_024, cpuMs })
  }
  return samples
}

export function sampleProcesses(): ProcessSample[] {
  try {
    const p = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,pgid=,%cpu=,state=,rss=,time='], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) return []
    return parseProcessSnapshot(p.stdout.toString())
  } catch {
    return []
  }
}

export function processTreePids(root: number, samples: ProcessSample[]): number[] {
  const children = new Map<number, number[]>()
  for (const row of samples) {
    const list = children.get(row.ppid) ?? []
    list.push(row.pid)
    children.set(row.ppid, list)
  }
  const out: number[] = []
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return out
}

export function accumulateRunResourceUsage(
  previous: RunResourceUsage,
  root: number,
  snapshot: ProcessSample[],
): RunResourceUsage {
  const pids = new Set(processTreePids(root, snapshot))
  const rows = snapshot.filter((row) => pids.has(row.pid))
  if (!rows.length) return previous
  const rssBytes = rows.reduce((total, row) => total + (row.rssBytes ?? 0), 0)
  const cpuMs = rows.reduce((total, row) => total + (row.cpuMs ?? 0), 0)
  return {
    cpuMs: Math.max(previous.cpuMs, cpuMs),
    peakRssBytes: Math.max(previous.peakRssBytes, rssBytes),
    samples: previous.samples + 1,
    source: 'sampled',
  }
}

type Subscriber = {
  root: number
  usage: RunResourceUsage
  observe(snapshot: ProcessSample[]): void
}

const subscribers = new Set<Subscriber>()
let samplerTimer: ReturnType<typeof setInterval> | null = null

function sampleAll(): void {
  const snapshot = sampleProcesses()
  for (const subscriber of subscribers) {
    subscriber.usage = accumulateRunResourceUsage(subscriber.usage, subscriber.root, snapshot)
    subscriber.observe(snapshot)
  }
}

export function observeRunProcessTree(
  root: number | null | undefined,
  observe: (snapshot: ProcessSample[]) => void,
): { usage(): RunResourceUsage; stop(): RunResourceUsage } | null {
  if (root == null || root <= 1) return null
  const subscriber: Subscriber = {
    root,
    usage: { cpuMs: 0, peakRssBytes: 0, samples: 0, source: 'sampled' },
    observe,
  }
  subscribers.add(subscriber)
  if (samplerTimer === null) samplerTimer = setInterval(sampleAll, RESOURCE_SAMPLE_INTERVAL_MS)
  const usage = () => ({ ...subscriber.usage })
  return {
    usage,
    stop() {
      subscribers.delete(subscriber)
      if (!subscribers.size && samplerTimer !== null) {
        clearInterval(samplerTimer)
        samplerTimer = null
      }
      return usage()
    },
  }
}
