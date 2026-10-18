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

export const TIME_ZONES = Intl.supportedValuesOf('timeZone')
const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone
export const DEFAULT_ZONE = TIME_ZONES.includes(resolvedZone) ? resolvedZone : 'America/New_York'
