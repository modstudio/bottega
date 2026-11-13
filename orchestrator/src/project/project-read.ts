// concern: project register reads
/** Leaf project-register lookups shared by destination adapters. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { StoredProjectSettings } from './project-settings.ts'

export type Project = {
  /** Hosted record identity, minted locally when this install has no hosted record. */
  recordId: string
  /** What it is called. Matches the directory name by default, not necessarily. */
  name: string
  /** Absolute path to its main checkout. */
  path: string
  /**
   * What it is built out of, as a coarse label like `php-laravel-vue`.
   *
   * Deliberately coarse and deliberately shared. Its whole job is to be the
   * same string for two projects that an agent would find similar, so evidence
   * pools; a precise per-project label would be a project id with extra steps.
   */
  stack: string | null
  /** Whether work here counts toward the canon denominator in the ratio. */
  canon: boolean
  /** ISO timestamp when the row was retired; null while the project is live. */
  retiredAt: string | null
  /**
   * Per-project settings, as JSON.
   *
   * A blob rather than columns because what a project needs to declare is not
   * knowable in advance — a tracker's status vocabulary, a display color, the
   * branch its trunk is called — and every one of those added as a column would
   * be another thing the code has to know about. The shapes that ARE relied on
   * are named in `ProjectSettings`, so the reliance is at least written down.
   */
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
    // Unreadable settings must not take the project out of the register: a
    // typo in one JSON blob would otherwise make a whole repo invisible to
    // routing and reporting at once.
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
