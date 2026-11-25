// concern: canon-stored-rows
/** Gathers one project's repository canon rows from a caller-selected store connection. */
import { readDocs } from '../doc/doc-authoritative-read.ts'
import { composeCanonRows } from './canon-hydrate.ts'

export async function storedRepositoryCanonRows(
  project: string,
  database?: Parameters<typeof readDocs>[1],
) {
  const [globalRows, projectRows] = await Promise.all([
    readDocs({ scope: 'canon', subject: null, status: 'current' }, database),
    readDocs({ scope: 'canon', subject: project, status: 'current' }, database),
  ])
  return composeCanonRows(globalRows, [], projectRows)
}
