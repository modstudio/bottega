// concern: process-liveness
/**
 * Knows whether an operating-system process id is alive. Must not know runs,
 * worktrees, the database, routing, transports, or CLI adapters.
 */
export { pidAlive, processStartTime } from '../../../shared/process-identity.ts'
