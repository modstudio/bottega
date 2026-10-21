import { setPriority } from 'node:os'

const RUN_CHILD_NICENESS = 10

/** Lower one run child and let descendants inherit the scheduling priority. */
export function lowerRunChildPriority<T extends { pid?: number }>(
  child: T,
  recordWarning?: (message: string) => void,
): T {
  try {
    if (!child.pid) throw new Error('spawn returned no child pid')
    setPriority(child.pid, RUN_CHILD_NICENESS)
  } catch (error) {
    const message = `could not set run child niceness to ${RUN_CHILD_NICENESS}: ${String(error)}`
    console.error(`orch: ${message}`)
    recordWarning?.(message)
  }
  return child
}
