import { setPriority } from 'node:os'

export const RUN_CHILD_NICENESS = 10

/** Lower one agent child and let descendants inherit the scheduling priority. */
export function lowerRunChildPriority(
  pid: number | undefined,
  warn: (message: string) => void,
): void {
  try {
    if (!pid) throw new Error('spawn returned no child pid')
    setPriority(pid, RUN_CHILD_NICENESS)
  } catch (error) {
    warn(`could not set run child niceness to ${RUN_CHILD_NICENESS}: ${String(error)}`)
  }
}
