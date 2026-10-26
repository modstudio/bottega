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

/** How a connection reaches the store: writable, SQLite-enforced read-only, or the immutable snapshot. */
export type StoreOpenMode = 'read-write' | 'read-only' | 'read-only-immutable'

/**
 * The process opens one store handle for its whole life, so a write requested after that handle
 * was opened read-only cannot be served: SQLite would fail later with a bare "attempt to write a
 * readonly database". The condition is named here instead, and the handle is never silently
 * reopened — a caller whose write authority arrives after the store opened (for example a broker
 * declaration) must declare it before the store first opens.
 */
export function cachedHandleWriteRefusal(
  cachedOpenMode: StoreOpenMode | null,
  writableRequested: boolean,
  path: string,
): string | null {
  if (!writableRequested || cachedOpenMode === null || cachedOpenMode === 'read-write') return null
  return (
    `refusing to write the orchestrator store through a process handle opened read-only: ${path}\n` +
    'invariant: A process holds one store handle for its whole life, and a store opened read-only cannot be written through afterwards.\n' +
    'condition: this process opened the store read-only earlier, before its write authority was declared.\n' +
    'cleared by: declare the write authority before the store first opens, or run the command as an operator from the main checkout'
  )
}

/**
 * How long the handle that asks lives. A one-shot reader — a command's single check — tolerates
 * reading the store as of its open. A persistent handle is the process connection a long-lived
 * command such as the orchestrator MCP server holds for its whole life.
 */
export type ReaderLifetime = 'one-shot' | 'persistent'

/**
 * The immutable open is a snapshot: it reads the store as of the open and never sees a later
 * writer. Only the one-shot reader may take it, so a persistent restricted handle takes plain
 * read-only instead — still refused writes by SQLite itself, and still seeing every writer that
 * arrives afterwards.
 */
export function readerOpenMode(lifetime: ReaderLifetime, openMode: StoreOpenMode): StoreOpenMode {
  if (lifetime === 'persistent' && openMode === 'read-only-immutable') return 'read-only'
  return openMode
}

/** What the adapter established when the plain read-only open of a persistent handle failed. */
export type PersistentReadOnlyFacts = {
  path: string
  storeDirectory: string
  walOrShmSidecarPresent: boolean
  storeDirectoryWritable: boolean
  failure: string
}

/**
 * The refusal a persistent restricted reader gets when no plain read-only open can be
 * established. The usual cause is a store with no WAL sidecar: SQLite refuses to read such a
 * store through a read-only connection, because a read-only connection cannot establish the
 * shared-memory sidecar it would need — and the immutable open, which would read it, is the
 * silent snapshot a persistent reader must not take. The text names the condition that
 * refused it rather than reporting the bare failure.
 */
export function persistentReadOnlyRefusal(facts: PersistentReadOnlyFacts): string {
  const condition = facts.walOrShmSidecarPresent
    ? 'the read-only open was refused'
    : 'the store has no -wal/-shm sidecar and a read-only connection cannot establish one' +
      (facts.storeDirectoryWritable
        ? ''
        : `, and this process cannot write the store directory (${facts.storeDirectory})`)
  return (
    `refusing to read the orchestrator store from a long-lived restricted process: ${facts.path}\n` +
    'invariant: A persistent reader must see every later writer, so it never takes the immutable open, which reads the store as of its open.\n' +
    `condition: ${condition}: ${facts.failure}\n` +
    `cleared by: run the command as an operator from the main checkout, which opens the store for writing and leaves its sidecars behind, or set BOTTEGA_ORCHESTRATOR_DB to a scratch copy under the OS temporary directory (${resolve(tmpdir())})`
  )
}
