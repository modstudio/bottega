export { compactTokens } from '../../../../shared/compact-number'

import { compactTokens } from '../../../../shared/compact-number'

const compactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export function vendorFigures(vendors: { agent: string; tokens: number }[]) {
  return vendors.length
    ? vendors.map((vendor) => `${vendor.agent} ${compactTokens(vendor.tokens)}`).join(' · ')
    : '-'
}

export function compactBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${compactNumber.format(value / 1024)} KB`
  return `${compactNumber.format(value / (1024 * 1024))} MB`
}

export function duration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${seconds}s`
}

export function relativeTime(value: string | number | Date) {
  const date = new Date(value)
  const delta = Date.now() - date.getTime()
  if (delta < 90_000) return 'now'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  if (delta < 172_800_000) return 'yesterday'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(date)
}

export function collectedTime(value: string | null) {
  if (!value) return 'never collected'
  return `collected ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(value)).toLowerCase()}`
}

/** A run's time as the dashboard prints it, in the operator's zone. */
export function runEasternTime(value: string, includeDay = false) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    ...(includeDay ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? ''
  const time = `${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`
  return includeDay ? `${part('month')} ${part('day')} ${time}` : time
}
