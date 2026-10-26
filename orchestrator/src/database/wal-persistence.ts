// concern: database
/** The one definition of SQLite persistent WAL. Dependency-free so an entry that must not load the store graph — the detached run entry — can still keep the rule. Must not open a connection or know a store path. */
import { constants, type Database } from 'bun:sqlite'

/**
 * SQLite deletes -wal and -shm when the last connection to a WAL store closes, unless that
 * connection asked for a persistent WAL. The store's ordinary idle state has no writer holding
 * it, and a sidecar-less WAL store cannot be opened read-only at all, so a reader that arrives
 * afterwards — a worker's persistent handle — would find the store unopenable. The last writer
 * to close decides, so every writable open sets the flag, not only the one that first
 * established WAL journaling.
 */
export function keepJournalSidecars(database: Database): void {
  database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1)
}
