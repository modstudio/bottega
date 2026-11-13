// concern: project register reads
/** Leaf project-register lookups shared by destination adapters. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { StoredProjectSettings } from './project-settings.ts'

export type Project = {
  recordId: string
  name: string
  path: string
  stack: string | null
  canon: boolean
  retiredAt: string | null
  settings: StoredProjectSettings
}

type ProjectRow = {
  record_id: string
  name: string
  path: string
  stack: string | null
  canon: number
  settings: string | null
  retired_at?: string | null
}

function parseProject(row: ProjectRow): Project {
  let settings: StoredProjectSettings = {}
  try {
    settings = row.settings ? JSON.parse(row.settings) : {}
  } catch {
    settings = {}
  }
  return {
    recordId: row.record_id,
    name: row.name,
    path: row.path,
    stack: row.stack,
    canon: row.canon === 1,
    retiredAt: row.retired_at ?? null,
    settings,
  }
}

export function projects(opts?: { retired?: boolean }, database: Database = db()): Project[] {
  const sql = opts?.retired
    ? 'SELECT * FROM project WHERE retired_at IS NOT NULL ORDER BY name'
    : 'SELECT * FROM project WHERE retired_at IS NULL ORDER BY name'
  return (database.query(sql).all() as ProjectRow[]).map(parseProject)
}

export function projectRowByName(name: string, database: Database = db()): Project | null {
  const row = database.query('SELECT * FROM project WHERE name = ?').get(name) as ProjectRow | null
  return row ? parseProject(row) : null
}

export function projectByName(name: string, database: Database = db()): Project | null {
  const project = projectRowByName(name, database)
  return project?.retiredAt ? null : project
}

export function projectByRecordId(recordId: string, database: Database = db()): Project | null {
  const row = database
    .query('SELECT * FROM project WHERE record_id = ?')
    .get(recordId) as ProjectRow | null
  if (!row) return null
  const project = parseProject(row)
  return project.retiredAt ? null : project
}
