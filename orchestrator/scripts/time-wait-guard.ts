// concern: postgres-test-time-wait
/** Parses test-run socket samples and decides whether connection churn remains bounded. */

export const TIME_WAIT_PEAK_FRACTION = 0.1

export type TimeWaitSample = { count: number } | { reason: string }

function remotePort(address: string): string | null {
  const match = /[.:](\d+)$/.exec(address)
  return match?.[1] ?? null
}

export function parseNetstatTimeWait(output: string, port: number): TimeWaitSample {
  const lines = output.split('\n')
  if (!lines.some((line) => /^Proto\s+.*Foreign Address.*State/i.test(line.trim()))) {
    return { reason: 'netstat output had no recognisable TCP header' }
  }
  let count = 0
  for (const line of lines) {
    const fields = line.trim().split(/\s+/)
    if (!/^tcp\d*$/i.test(fields[0] ?? '') || !fields.includes('TIME_WAIT')) continue
    if (remotePort(fields[4] ?? '') === String(port)) count++
  }
  return { count }
}

export function parseSsTimeWait(output: string, port: number): TimeWaitSample {
  const lines = output.split('\n')
  if (!lines.some((line) => /^Recv-Q\s+Send-Q\s+.*Peer Address:Port/i.test(line.trim()))) {
    return { reason: 'ss output had no recognisable TCP header' }
  }
  let count = 0
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4) continue
    if (remotePort(fields[3] ?? '') === String(port)) count++
  }
  return { count }
}

export function timeWaitPeakExceeded(
  peak: number,
  ephemeralRange: number,
  fraction = TIME_WAIT_PEAK_FRACTION,
): boolean {
  return peak > ephemeralRange * fraction
}
