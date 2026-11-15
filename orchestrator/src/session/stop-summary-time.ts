// concern: session stop summary time rendering
/** Renders one Stop instant in the configured user zone or the machine's local zone. */

const formatter = (timeZone?: string) =>
  new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  })

export function formatStopTime(instant: string, timeZone?: string | null): string {
  const value = new Date(instant)
  if (timeZone) {
    try {
      return formatter(timeZone).format(value)
    } catch {
      // A stale or hand-edited cache must not break Stop.
    }
  }
  return formatter().format(value)
}
