// concern: postgres-test-time-wait
/** Parses test-run socket samples and decides whether connection churn remains bounded. */

const TIME_WAIT_PEAK_FRACTION = 0.1

export type TimeWaitSample =
  | { total: number; byDestination: Map<string, number> }
  | { reason: string }

export function parseNetstatTimeWait(output: string): TimeWaitSample {
  const lines = output.split('\n')
  if (!lines.some((line) => /^Proto\s+.*Foreign Address.*State/i.test(line.trim()))) {
    return { reason: 'netstat output had no recognisable TCP header' }
  }
  const byDestination = new Map<string, number>()
  let total = 0
  for (const line of lines) {
    const fields = line.trim().split(/\s+/)
    if (!/^tcp\d*$/i.test(fields[0] ?? '') || !fields.includes('TIME_WAIT')) continue
    const destination = fields[4]
    if (!destination) continue
    total++
    byDestination.set(destination, (byDestination.get(destination) ?? 0) + 1)
  }
  return { total, byDestination }
}

export function parseSsTimeWait(output: string): TimeWaitSample {
  const lines = output.split('\n')
  const header = lines.findIndex((line) =>
    /^(?:State\s+)?Recv-Q\s+Send-Q\s+.*Peer Address:Port/i.test(line.trim()),
  )
  if (header < 0) {
    return { reason: 'ss output had no recognisable TCP header' }
  }
  const hasState = /^State\s+/i.test(lines[header]!.trim())
  const byDestination = new Map<string, number>()
  let total = 0
  for (const line of lines.slice(header + 1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < (hasState ? 5 : 4)) continue
    if (hasState && !/^TIME-WAIT$/i.test(fields[0] ?? '')) continue
    const destination = fields[hasState ? 4 : 3]
    if (!destination) continue
    total++
    byDestination.set(destination, (byDestination.get(destination) ?? 0) + 1)
  }
  return { total, byDestination }
}

export function busiestDestination(sample: Exclude<TimeWaitSample, { reason: string }>): {
  count: number
  destination?: string
} {
  let busiest: { count: number; destination?: string } = { count: 0 }
  for (const [destination, count] of sample.byDestination) {
    if (count > busiest.count) busiest = { count, destination }
  }
  return busiest
}

export function timeWaitPeakExceeded(
  peak: number,
  ephemeralRange: number,
  fraction = TIME_WAIT_PEAK_FRACTION,
): boolean {
  return peak > ephemeralRange * fraction
}
