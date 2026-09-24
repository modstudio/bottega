import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'

export type PortPair = {
  id: number
  source_project_id: number
  target_project_id: number
  created_at: string
}

export type PortBaseline = {
  pair_id: number
  source_commit: string | null
  scanned_at: string | null
}

export type PortSkip = {
  id: number
  pair_id: number
  candidate: string
  reason: string
  skipped_at: string
}

export type LedgerSource = {
  source_project_id: number
  commits: string[]
  paths: string[]
  note: string
}

export type LedgerRef = {
  task_key: string
  target_project_id: number
  note: string
  created_at: string
  resolved_at: string | null
  sources: LedgerSource[]
}

export type DoctrineRule = {
  number: number
  title: string
  body: string
  created_at: string
  retired_at: string | null
}

export function pairByProjects(sourceProjectId: number, targetProjectId: number): PortPair | null {
  return db()
    .query('SELECT * FROM port_pair WHERE source_project_id=? AND target_project_id=?')
    .get(sourceProjectId, targetProjectId) as PortPair | null
}

export function addPair(sourceProjectId: number, targetProjectId: number, at = nowIso()): PortPair {
  writableDb()
  writeTransaction(() => {
    db()
      .query(
        `INSERT INTO port_pair (source_project_id, target_project_id, created_at)
       VALUES (?,?,?) ON CONFLICT(source_project_id, target_project_id) DO NOTHING`,
      )
      .run(sourceProjectId, targetProjectId, at)
    const pair = pairByProjects(sourceProjectId, targetProjectId)!
    db()
      .query(
        `INSERT INTO port_baseline (pair_id, source_commit, scanned_at) VALUES (?,NULL,NULL)
       ON CONFLICT(pair_id) DO NOTHING`,
      )
      .run(pair.id)
  })
  return pairByProjects(sourceProjectId, targetProjectId)!
}

export function baselineForPair(pairId: number): PortBaseline | null {
  return db()
    .query('SELECT * FROM port_baseline WHERE pair_id=?')
    .get(pairId) as PortBaseline | null
}

export function setBaseline(
  pairId: number,
  sourceCommit: string | null,
  scannedAt: string | null = sourceCommit === null ? null : nowIso(),
): PortBaseline {
  writableDb()
  db()
    .query(
      `INSERT INTO port_baseline (pair_id, source_commit, scanned_at) VALUES (?,?,?)
     ON CONFLICT(pair_id) DO UPDATE SET
       source_commit=excluded.source_commit, scanned_at=excluded.scanned_at`,
    )
    .run(pairId, sourceCommit, scannedAt)
  return baselineForPair(pairId)!
}

export function listSkips(pairId: number): PortSkip[] {
  return db().query('SELECT * FROM port_skip WHERE pair_id=? ORDER BY id').all(pairId) as PortSkip[]
}

export function addSkip(
  pairId: number,
  candidate: string,
  reason: string,
  skippedAt = nowIso(),
): PortSkip {
  writableDb()
  const id = (
    db()
      .query(
        `INSERT INTO port_skip (pair_id, candidate, reason, skipped_at) VALUES (?,?,?,?)
     RETURNING id`,
      )
      .get(pairId, candidate, reason, skippedAt) as { id: number }
  ).id
  return db().query('SELECT * FROM port_skip WHERE id=?').get(id) as PortSkip
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('invalid string array in port ledger')
  }
  return parsed
}

export function ledgerRef(targetProjectId: number, taskKey: string): LedgerRef | null {
  const ref = db()
    .query('SELECT * FROM port_ref WHERE target_project_id=? AND task_key=?')
    .get(targetProjectId, taskKey) as Omit<LedgerRef, 'sources'> | null
  if (!ref) return null
  const rows = db()
    .query(
      `SELECT source_project_id, commits, paths, note FROM port_ref_source
     WHERE target_project_id=? AND task_key=? ORDER BY id`,
    )
    .all(targetProjectId, taskKey) as {
    source_project_id: number
    commits: string
    paths: string
    note: string
  }[]
  return {
    ...ref,
    sources: rows.map((row) => ({
      source_project_id: row.source_project_id,
      commits: parseStringArray(row.commits),
      paths: parseStringArray(row.paths),
      note: row.note,
    })),
  }
}

export function listLedgerRefs(includeResolved = false): LedgerRef[] {
  const keys = db()
    .query(
      `SELECT target_project_id,task_key FROM port_ref${includeResolved ? '' : ' WHERE resolved_at IS NULL'} ORDER BY target_project_id,task_key`,
    )
    .all() as { target_project_id: number; task_key: string }[]
  return keys.map(({ target_project_id, task_key }) => ledgerRef(target_project_id, task_key)!)
}

export function setLedgerRef(input: {
  taskKey: string
  targetProjectId: number
  note: string
  sources: LedgerSource[]
  createdAt?: string
}): LedgerRef {
  writableDb()
  if (input.sources.length === 0) throw new Error('a ledger ref needs at least one source project')
  if (
    new Set(input.sources.map((source) => source.source_project_id)).size !== input.sources.length
  ) {
    throw new Error('a ledger ref may name each source project only once')
  }
  writeTransaction(() => {
    db()
      .query(
        `INSERT INTO port_ref (task_key, target_project_id, note, created_at) VALUES (?,?,?,?)
       ON CONFLICT(target_project_id,task_key) DO UPDATE SET note=excluded.note`,
      )
      .run(input.taskKey, input.targetProjectId, input.note, input.createdAt ?? nowIso())
    db()
      .query('DELETE FROM port_ref_source WHERE target_project_id=? AND task_key=?')
      .run(input.targetProjectId, input.taskKey)
    const insert = db().query(
      `INSERT INTO port_ref_source
         (task_key, target_project_id, source_project_id, commits, paths, note) VALUES (?,?,?,?,?,?)`,
    )
    for (const source of input.sources) {
      insert.run(
        input.taskKey,
        input.targetProjectId,
        source.source_project_id,
        JSON.stringify(source.commits),
        JSON.stringify(source.paths),
        source.note,
      )
    }
  })
  return ledgerRef(input.targetProjectId, input.taskKey)!
}

export function removeLedgerRef(targetProjectId: number, taskKey: string): boolean {
  writableDb()
  return (
    db()
      .query('DELETE FROM port_ref WHERE target_project_id=? AND task_key=?')
      .run(targetProjectId, taskKey).changes > 0
  )
}

export function resolveLedgerRef(
  targetProjectId: number,
  taskKey: string,
  resolvedAt = nowIso(),
): LedgerRef | null {
  writableDb()
  const existing = ledgerRef(targetProjectId, taskKey)
  if (!existing || existing.resolved_at) return existing
  db()
    .query(
      'UPDATE port_ref SET resolved_at=? WHERE target_project_id=? AND task_key=? AND resolved_at IS NULL',
    )
    .run(resolvedAt, targetProjectId, taskKey)
  return ledgerRef(targetProjectId, taskKey)
}

export function listDoctrineRules(includeRetired = true): DoctrineRule[] {
  return db()
    .query(
      `SELECT * FROM port_doctrine${includeRetired ? '' : ' WHERE retired_at IS NULL'} ORDER BY number`,
    )
    .all() as DoctrineRule[]
}

export function addDoctrineRule(
  number: number,
  title: string,
  body: string,
  createdAt = nowIso(),
): DoctrineRule {
  writableDb()
  db()
    .query(`INSERT INTO port_doctrine (number, title, body, created_at) VALUES (?,?,?,?)`)
    .run(number, title, body, createdAt)
  return db().query('SELECT * FROM port_doctrine WHERE number=?').get(number) as DoctrineRule
}

export function retireDoctrineRule(number: number, retiredAt = nowIso()): boolean {
  writableDb()
  return (
    db()
      .query('UPDATE port_doctrine SET retired_at=? WHERE number=? AND retired_at IS NULL')
      .run(retiredAt, number).changes > 0
  )
}
