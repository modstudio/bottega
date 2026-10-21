// concern: monitor report filter
/** Shared project and time-window parameters for historical reports. */

export type ReportFilterOptions = { project?: string; sinceMs: number | null; now?: number }

export function reportFilter(options: ReportFilterOptions) {
  const cutoff =
    options.sinceMs === null
      ? null
      : new Date((options.now ?? Date.now()) - options.sinceMs).toISOString()
  return {
    cutoff,
    parameters: [options.project ?? null, options.project ?? null, cutoff, cutoff] as const,
  }
}
