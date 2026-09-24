import type { NormalizedEvent } from './transport.ts'

/** Preserve CLI tool evidence after its live stream has been consumed by the event log. */
export function cliResultEvents(
  streamed: readonly NormalizedEvent[],
  terminal: readonly NormalizedEvent[],
): NormalizedEvent[] {
  return [...streamed.filter((event) => event.kind === 'tool'), ...terminal]
}
