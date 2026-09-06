export const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString()

export function easternTime(value: string | number | Date, includeDay = false): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    ...(includeDay ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? ''
  const time = `${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`
  return includeDay ? `${part('month')} ${part('day')} ${time}` : time
}
