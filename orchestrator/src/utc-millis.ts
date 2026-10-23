// concern: stored timestamps
/** Parses stored SQLite timestamps, whose absent offset means UTC. */

export function utcMillis(value: string): number {
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`)
}
