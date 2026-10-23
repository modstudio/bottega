// concern: monitor report filter
/** Shared project and time-window parameters for historical reports. */

export type ReportFilterOptions = {
  project?: string
  sinceMs?: number | null
  now?: number
  since?: string
  until?: string
}

export function reportFilter(options: ReportFilterOptions) {
  const cutoff =
    options.since !== undefined
      ? options.since
      : options.sinceMs == null
        ? null
        : new Date((options.now ?? Date.now()) - options.sinceMs).toISOString()
  return {
    cutoff,
    parameters: [
      options.project ?? null,
      options.project ?? null,
      cutoff,
      cutoff,
      options.until ?? null,
      options.until ?? null,
    ] as const,
  }
}
