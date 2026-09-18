export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const
export type Weekday = (typeof WEEKDAYS)[number]

export type ReportSchedule = {
  cadence: 'daily' | 'weekly'
  hour: number
  weekday: Weekday | null
  zone: string
}

const WEEKDAY_NUMBER = new Map<Weekday, number>([
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
])

type LocalDate = { year: number; month: number; day: number }

function localDate(at: Date, zone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((value) => value.type === type)?.value)
  return { year: part('year'), month: part('month'), day: part('day') }
}

function shiftedDate(value: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(value.year, value.month - 1, value.day + days))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

function localInstant(value: LocalDate, hour: number, zone: string) {
  let instant = new Date(Date.UTC(value.year, value.month - 1, value.day, hour))
  for (let attempt = 0; attempt < 3; attempt++) {
    const rendered = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant)
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(rendered.find((item) => item.type === type)?.value)
    const renderedUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'))
    const wantedUtc = Date.UTC(value.year, value.month - 1, value.day, hour)
    instant = new Date(instant.getTime() + wantedUtc - renderedUtc)
  }
  return instant
}

export function nextReportArrival(input: ReportSchedule, now = new Date()) {
  const today = localDate(now, input.zone)
  for (let days = 0; days <= 7; days++) {
    const date = shiftedDate(today, days)
    if (
      input.cadence === 'weekly' &&
      new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() !==
        WEEKDAY_NUMBER.get(input.weekday!)
    )
      continue
    const instant = localInstant(date, input.hour, input.zone)
    if (instant.getTime() <= now.getTime()) continue
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: input.zone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(instant)
    return `Next arrival: ${formatted} (${input.zone}).`
  }
  throw new Error(`could not determine the next report arrival in ${input.zone}`)
}

export const TIME_ZONES = Intl.supportedValuesOf('timeZone')
const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone
export const DEFAULT_ZONE = TIME_ZONES.includes(resolvedZone) ? resolvedZone : 'America/New_York'
