// concern: canon-stored-rows
/** Gathers one project's repository canon rows from a caller-selected store connection. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { listDocsStore } from '../doc/doc-read-store.ts'
import { composeCanonRows } from './canon-hydrate.ts'

export function storedRepositoryCanonRows(project: string, database: Database = db()) {
  return composeCanonRows(
    listDocsStore({ scope: 'canon', subject: null, status: 'current' }, database),
    [],
    listDocsStore({ scope: 'canon', subject: project, status: 'current' }, database),
  )
}
