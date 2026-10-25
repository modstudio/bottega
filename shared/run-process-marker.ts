// concern: run-process-marker
/**
 * Proves a run started a process, from the environment the orchestrator gave it.
 *
 * The delegation marker reaches the children the harness spawns for a run and
 * refuses re-delegation, but the worker-environment gate scrubs it from the gate
 * and focused-test children the host brokers start. RUN_PROCESS_MARKER_ENV is
 * stamped on those children instead: it carries no run identity, so such a child
 * still looks like an unprivileged caller. Neither name appears in an operator's
 * own shell, so automatic orphan reclaim reads their presence as ownership proof.
 *
 * These names are one route to that proof, not the only one: a process in a run's
 * recorded process group for the tree the run used is proven without any
 * environment read. They are also not on every run child. Host recipe steps and
 * `sudo` as-user recipe steps carry neither name, so a process a run started
 * there has no environment proof at all and automatic reclaim keeps it.
 */
export const RUN_PROCESS_MARKER_ENV = 'BOTTEGA_RUN_PROCESS'

/** Environment names whose presence proves a run started this process. */
export const RUN_PROCESS_ENV_NAMES = ['BOTTEGA_DEPTH', RUN_PROCESS_MARKER_ENV] as const
