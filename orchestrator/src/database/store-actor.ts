// concern: database
/** The store's write authority as one pure decision over gathered caller facts. Must not gather facts, open a connection, or name a store path beyond the refusal text. */
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

/** Who is calling, and how the store was named. Gathered once by the adapter; the decision is pure. */
export type StoreActorFacts = {
  /** A linked-worktree binary is using this store. */
  linkedWorktreeBinary: boolean
  /** BOTTEGA_ORCHESTRATOR_DB named the store. */
  namedStoreOverride: boolean
  /** The named store is the registered main store. */
  namedStoreIsMainStore: boolean
  /** BOTTEGA_ORCHESTRATOR_DB_WRITE=1 is the operator's recorded insistence, which lifts the linked-worktree condition alone. */
  operatorWriteInsistence: boolean
  /** The caller classifies as a worker. */
  workerCaller: boolean
  /** The ask server, the one declared broker channel. */
  brokerChannel: boolean
}

/** The refusal a linked-worktree binary reports; the operator's insistence is what clears it. */
export const LINKED_WORKTREE_WRITE_REFUSAL =
  'refusing to write run or project rows to the registered main store from a linked worktree\n' +
  'invariant: A linked-worktree binary cannot write lifecycle rows to the registered main store.\n' +
  'cleared by: orch <command> with BOTTEGA_ORCHESTRATOR_DB_WRITE=1, or set BOTTEGA_ORCHESTRATOR_DB to a scratch copy'

/**
 * The refusal names the invariant it protects and the edits that clear it, including the one
 * a worker can make for itself: a store under OS temporary state is not the shared store.
 */
const WORKER_STORE_WRITE_REFUSAL =
  'refusing to write orchestrator rows from a worker process\n' +
  'invariant: A worker writes the shared store only through its ask server, the one declared broker channel; a store under OS temporary state is not the shared store.\n' +
  `cleared by: ask, message or note through the worker channel, or set BOTTEGA_ORCHESTRATOR_DB to a scratch copy under the OS temporary directory (${resolve(tmpdir())}), or run the command as an operator from the main checkout`

/**
 * Location and write authority are separate: a restricted actor reads the store
 * under any name and never writes it. A linked-worktree binary is restricted
 * unless the operator insists; a worker caller always is. The operator's
 * insistence lifts the linked-worktree condition alone, so a worker cannot lift
 * its own restriction with it. The one declared broker channel, the worker's ask
 * server, is the single exception.
 */
export function restrictedStoreActor(facts: StoreActorFacts): boolean {
  if (facts.brokerChannel) return false
  if (facts.workerCaller) return true
  return (
    facts.linkedWorktreeBinary &&
    !facts.operatorWriteInsistence &&
    (!facts.namedStoreOverride || facts.namedStoreIsMainStore)
  )
}

/** The refusal a refused write reports, naming the condition that refused it. */
export function storeWriteRefusal(workerCaller: boolean): string {
  return workerCaller ? WORKER_STORE_WRITE_REFUSAL : LINKED_WORKTREE_WRITE_REFUSAL
}
