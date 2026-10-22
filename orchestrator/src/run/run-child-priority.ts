import { setPriority } from 'node:os'

const RUN_CHILD_NICENESS = 10
export const HOST_TOOL_NICENESS = 0

/** Set one child process's scheduling priority and let descendants inherit it. */
export function setChildPriority<T extends { pid?: number }>(
  child: T,
  niceness: number,
  recordWarning?: (message: string) => void,
): T {
  try {
    if (!child.pid) throw new Error('spawn returned no child pid')
    setPriority(child.pid, niceness)
  } catch (error) {
    const message = `could not set child niceness to ${niceness}: ${String(error)}; the process hosting the broker is niced, so run it un-niced`
    console.error(`orch: ${message}`)
    recordWarning?.(message)
  }
  return child
}

/** Lower one run child and let descendants inherit the scheduling priority. */
export function lowerRunChildPriority<T extends { pid?: number }>(
  child: T,
  recordWarning?: (message: string) => void,
): T {
  return setChildPriority(child, RUN_CHILD_NICENESS, recordWarning)
}
