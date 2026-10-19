import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import type { Project } from '../project/projects.ts'

export function projectsForDryRun(path: string): Project[] {
  if (!existsSync(path)) throw new Error(`orchestrator database does not exist: ${path}`)
  try {
    const readonly = new Database(path, { readonly: true })
    try {
      const rows = readonly
        .query('SELECT record_id, name, path, stack, canon, settings FROM project ORDER BY name')
        .all() as {
        record_id: string
        name: string
        path: string
        stack: string | null
        canon: number
        settings: string | null
      }[]
      return rows.map((row) => {
        let settings: Project['settings'] = {}
        try {
          settings = row.settings ? JSON.parse(row.settings) : {}
        } catch {
          settings = {}
        }
        const { record_id: recordId, ...project } = row
        return { ...project, recordId, canon: row.canon === 1, retiredAt: null, settings }
      })
    } finally {
      readonly.close()
    }
  } catch (error) {
    let walWithoutSharedMemory = false
    try {
      const header = readFileSync(path).subarray(0, 20)
      walWithoutSharedMemory = header[18] === 2 && header[19] === 2 && !existsSync(`${path}-shm`)
    } catch {}
    if (!walWithoutSharedMemory) throw error
    throw new Error(
      `cannot read project register at ${path}: the database appears to be WAL-mode with no ${path}-shm sidecar, ` +
        'so a read-only connection cannot open it. Copy the -wal and -shm files alongside the .db, or checkpoint ' +
        'the source first with PRAGMA wal_checkpoint(TRUNCATE) before copying. ' +
        `Underlying error: ${String(error)}`,
    )
  }
}
