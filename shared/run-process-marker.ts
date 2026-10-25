// concern: run-process-marker
/**
 * Proves a run started a process, from the environment the orchestrator gave it.
 *
 * The delegation marker is set on every run child and refuses re-delegation, but
 * the worker-environment gate scrubs it from the gate and focused-test children
 * the host brokers start. RUN_PROCESS_MARKER_ENV is stamped on those children
 * instead: it carries no run identity, so such a child still looks like an
 * unprivileged caller. Neither name appears in an operator's own shell, so
 * automatic orphan reclaim reads their presence as ownership proof.
 */
export const RUN_PROCESS_MARKER_ENV = 'BOTTEGA_RUN_PROCESS'

/** Environment names whose presence proves a run started this process. */
export const RUN_PROCESS_ENV_NAMES = ['BOTTEGA_DEPTH', RUN_PROCESS_MARKER_ENV] as const
