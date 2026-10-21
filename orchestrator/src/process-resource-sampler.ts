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
  startTime?: string
}

export type RunResourceUsage = {
  cpuMs: number | null
  peakRssBytes: number | null
  samples: number
  source: 'sampled' | 'none' | 'unavailable'
}

export type RunResourceObserver = {
  usage(): RunResourceUsage
  stop(): RunResourceUsage
}

export type RunResourceAccumulator = {
  usage: RunResourceUsage
  active: boolean
}

type ProcessSnapshot = { rows: ProcessSample[]; available: boolean }

export const PROCESS_SNAPSHOT_FIELDS = [
  'pid',
  'ppid',
  'pgid',
  '%cpu',
  'state',
  'rss',
  'time',
  'lstart',
] as const

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
    const startTime = parts.length > 7 ? parts.slice(7).join(' ') : undefined
    samples.push({
      pid,
      ppid,
      pgid,
      cpu,
      state,
      rssBytes: rssKb * 1_024,
      cpuMs,
      startTime,
    })
  }
  return samples
}

function readProcessSnapshot(): ProcessSnapshot {
  try {
    const columns = PROCESS_SNAPSHOT_FIELDS.map((field) => `${field}=`).join(',')
    const p = Bun.spawnSync(['ps', '-axo', columns], {
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) return { rows: [], available: false }
    return { rows: parseProcessSnapshot(p.stdout.toString()), available: true }
  } catch {
    return { rows: [], available: false }
  }
}

export function sampleProcesses(): ProcessSample[] {
  return readProcessSnapshot().rows
}

function processTreePids(root: number, samples: ProcessSample[], rootPresent: boolean): number[] {
  if (!rootPresent) return []
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

/** A tree whose root was actually observed in this process-table snapshot. */
export function observedProcessTreePids(root: number, samples: ProcessSample[]): number[] {
  return processTreePids(
    root,
    samples,
    samples.some((row) => row.pid === root),
  )
}

/** A liveness tree keeps the recorded root even when ps omits or truncates its row. */
export function liveProcessTreePids(root: number, samples: ProcessSample[]): number[] {
  return processTreePids(root, samples, true)
}

export function accumulateRunResourceUsage(
  previous: RunResourceUsage,
  root: number,
  snapshot: ProcessSample[],
  rootPresent: boolean,
): RunResourceUsage {
  if (!rootPresent) return previous
  const pids = new Set(processTreePids(root, snapshot, rootPresent))
  const rows = snapshot.filter((row) => pids.has(row.pid))
  const rssBytes = rows.reduce((total, row) => total + (row.rssBytes ?? 0), 0)
  const cpuMs = rows.reduce((total, row) => total + (row.cpuMs ?? 0), 0)
  return {
    cpuMs: Math.max(previous.cpuMs ?? 0, cpuMs),
    peakRssBytes: Math.max(previous.peakRssBytes ?? 0, rssBytes),
    samples: previous.samples + 1,
    source: 'sampled',
  }
}

export function advanceRunResourceUsage(
  previous: RunResourceAccumulator,
  root: number,
  snapshot: ProcessSample[],
  rootPresent: boolean,
): RunResourceAccumulator {
  if (!previous.active) return previous
  return rootPresent
    ? {
        usage: accumulateRunResourceUsage(previous.usage, root, snapshot, rootPresent),
        active: true,
      }
    : { ...previous, active: false }
}

type Subscriber = {
  root: number
  rootStartTime: string | null
  usage: RunResourceUsage
  availableAttempts: number
  active: boolean
  observeIntervalMs: number
  nextObserveAt: number
  observe(snapshot: ProcessSample[]): void
}

const subscribers = new Set<Subscriber>()
let samplerTimer: ReturnType<typeof setInterval> | null = null
let samplerIntervalMs: number | null = null

function observeSubscriber(
  subscriber: Subscriber,
  snapshot: ProcessSnapshot,
  now: number,
  notify: boolean,
): void {
  if (snapshot.available) subscriber.availableAttempts++
  if (snapshot.available && subscriber.active) {
    if (!subscriber.rootStartTime) {
      subscriber.active = false
    } else {
      const rootPresent = snapshot.rows.some(
        (row) => row.pid === subscriber.root && row.startTime === subscriber.rootStartTime,
      )
      const next = advanceRunResourceUsage(
        { usage: subscriber.usage, active: subscriber.active },
        subscriber.root,
        snapshot.rows,
        rootPresent,
      )
      subscriber.usage = next.usage
      subscriber.active = next.active
    }
  }
  if (!notify || now < subscriber.nextObserveAt) return
  subscriber.nextObserveAt = now + subscriber.observeIntervalMs
  try {
    subscriber.observe(snapshot.rows)
  } catch (error) {
    console.error(`orch: process resource subscriber failed: ${error}`)
  }
}

function takeSample(subscriber?: Subscriber, notify = true): void {
  const snapshot = readProcessSnapshot()
  const now = Date.now()
  const targets = subscriber ? [subscriber] : [...subscribers]
  for (const target of targets) observeSubscriber(target, snapshot, now, notify)
}

function updateTimer(): void {
  const interval = subscribers.size
    ? Math.min(...[...subscribers].map((subscriber) => subscriber.observeIntervalMs))
    : null
  if (interval === samplerIntervalMs) return
  if (samplerTimer !== null) clearInterval(samplerTimer)
  samplerTimer = interval === null ? null : setInterval(takeSample, interval)
  samplerIntervalMs = interval
}

export function finalRunResourceUsage(
  usage: RunResourceUsage,
  availableAttempts: number,
): RunResourceUsage {
  if (usage.samples > 0) return { ...usage }
  return {
    cpuMs: null,
    peakRssBytes: null,
    samples: 0,
    source: availableAttempts > 0 ? 'none' : 'unavailable',
  }
}

export function observeRunProcessTree(
  root: number | null | undefined,
  rootStartTime: string | null,
  observeIntervalMs: number,
  observe: (snapshot: ProcessSample[]) => void,
): RunResourceObserver | null {
  if (root == null || root <= 1) return null
  const subscriber: Subscriber = {
    root,
    rootStartTime,
    usage: { cpuMs: null, peakRssBytes: null, samples: 0, source: 'none' },
    availableAttempts: 0,
    active: true,
    observeIntervalMs,
    nextObserveAt: 0,
    observe,
  }
  subscribers.add(subscriber)
  takeSample(subscriber)
  updateTimer()
  return {
    usage: () => finalRunResourceUsage(subscriber.usage, subscriber.availableAttempts),
    stop() {
      takeSample(subscriber, false)
      subscribers.delete(subscriber)
      updateTimer()
      return finalRunResourceUsage(subscriber.usage, subscriber.availableAttempts)
    },
  }
}
