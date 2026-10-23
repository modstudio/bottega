import { AsyncLocalStorage } from 'node:async_hooks'

/** Give one concern a process-local read-only command scope without sharing its state with another. */
export function createReadOnlyDatabaseAccess() {
  const access = new AsyncLocalStorage<true>()
  return {
    active: () => access.getStore() === true,
    run: <T>(action: () => T): T => access.run(true, action),
  }
}
