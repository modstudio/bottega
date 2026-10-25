// concern: run-process-marker
/**
 * The two environment names a run's own children carry, and who stamps each.
 *
 * BOTTEGA_DEPTH is the delegation marker the harness sets on the children it
 * spawns for a run. The worker-environment gate withholds it from the gate and
 * focused-test children the host brokers start, which stamp
 * RUN_PROCESS_MARKER_ENV instead: that name carries no run identity, so such a
 * child still looks like an unprivileged caller.
 */
export const RUN_PROCESS_MARKER_ENV = 'BOTTEGA_RUN_PROCESS'

/** The names above, for a reader that tests an environment for them. */
export const RUN_PROCESS_ENV_NAMES = ['BOTTEGA_DEPTH', RUN_PROCESS_MARKER_ENV] as const
