// concern: database file family
/** One inventory for the SQLite database and every sidecar that travels with it. */

export const DATABASE_SIDECAR_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const

export type DatabaseFileSuffix = (typeof DATABASE_SIDECAR_SUFFIXES)[number]
