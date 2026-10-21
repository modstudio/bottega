// concern: caller checkout confinement
/** Names the external caller checkout that this run must continue watching. */
export function callerWatch(
  callerCheckout: string | null,
  isolatedCwd: string | null,
  project: { name: string } | null,
) {
  return callerCheckout && callerCheckout !== isolatedCwd && project
    ? [{ project: project.name, path: callerCheckout }]
    : []
}
