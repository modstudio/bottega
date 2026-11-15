// concern: session stop summary time rendering
/** Renders one Stop instant in the configured user zone or the machine's local zone. */

import { isDisplayTimezone } from '../../../shared/machine-config.ts'

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
  if (isDisplayTimezone(timeZone)) return formatter(timeZone).format(value)
  return formatter().format(value)
}
