import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { activeRecordSpace, effectiveProjectSpace } from '../project-space.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { applyPortWriteResponse } from '../record/record-cache-port.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { overlayPortItems } from './port-overlay.ts'

export type PortPair = {
  id: number
  source_project_record_id: string
  target_project_record_id: string
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
  source_project_record_id: string
  commits: string[]
  paths: string[]
  note: string
}

export type LedgerRef = {
  task_key: string
  target_project_record_id: string
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

type SpaceRow = { space_id: string | null; record_id: string; version?: number }
function projectName(recordId: string): string {
  const row = db()
    .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
    .get(recordId)
  if (!row) throw new Error(`unknown project record id ${recordId}`)
  return row.name
}
function projectSpace(recordId: string): string | null {
  return effectiveProjectSpace(db(), projectName(recordId))
}
async function hostedSpace(recordId?: string): Promise<string> {
  const identity = await recordApiClient().whoami()
  const spaceId = recordId ? projectSpace(recordId) : identity.activeSpaceId
  if (!spaceId) throw new Error('record session has no active space')
  return spaceId
}

export function pairByProjects(sourceProjectId: string, targetProjectId: string): PortPair | null {
  const rows = db()
    .query(
      'SELECT id,source_project_record_id,target_project_record_id,created_at,space_id FROM port_pair WHERE source_project_record_id=? AND target_project_record_id=?',
    )
    .all(sourceProjectId, targetProjectId) as (PortPair & { space_id: string | null })[]
  const spaceId = projectSpace(targetProjectId)
  const selected =
    overlayPortItems(
      rows.filter((row) => row.space_id === null),
      rows.filter((row) => row.space_id === spaceId),
      (row) => `${row.source_project_record_id}:${row.target_project_record_id}`,
    )[0] ?? null
  if (!selected) return null
  const { space_id: _spaceId, ...pair } = selected
  return pair
}

export function addPairLocal(
  sourceProjectId: string,
  targetProjectId: string,
  at = nowIso(),
): PortPair {
  writableDb()
  writeTransaction(() => {
    db()
      .query(
        `INSERT INTO port_pair (record_id, source_project_record_id, target_project_record_id, created_at)
       VALUES (?,?,?,?) ON CONFLICT(source_project_record_id, target_project_record_id) WHERE space_id IS NULL DO NOTHING`,
      )
      .run(newRecordId(), sourceProjectId, targetProjectId, at)
    const pair = pairByProjects(sourceProjectId, targetProjectId)!
    db()
      .query(
        `INSERT INTO port_baseline (record_id, pair_id, source_commit, scanned_at) VALUES (?,?,NULL,NULL)
       ON CONFLICT(pair_id) DO NOTHING`,
      )
      .run(newRecordId(), pair.id)
  })
  return pairByProjects(sourceProjectId, targetProjectId)!
}

export function baselineForPair(pairId: number): PortBaseline | null {
  return db()
    .query('SELECT pair_id,source_commit,scanned_at FROM port_baseline WHERE pair_id=?')
    .get(pairId) as PortBaseline | null
}

export function setBaselineLocal(
  pairId: number,
  sourceCommit: string | null,
  scannedAt: string | null = sourceCommit === null ? null : nowIso(),
): PortBaseline {
  writableDb()
  db()
    .query(
      `INSERT INTO port_baseline (record_id, pair_id, source_commit, scanned_at) VALUES (?,?,?,?)
     ON CONFLICT(pair_id) DO UPDATE SET
       source_commit=excluded.source_commit, scanned_at=excluded.scanned_at`,
    )
    .run(newRecordId(), pairId, sourceCommit, scannedAt)
  return baselineForPair(pairId)!
}

export function listSkips(pairId: number): PortSkip[] {
  return db()
    .query(
      'SELECT id,pair_id,candidate,reason,skipped_at FROM port_skip WHERE pair_id=? ORDER BY id',
    )
    .all(pairId) as PortSkip[]
}

export function addSkipLocal(
  pairId: number,
  candidate: string,
  reason: string,
  skippedAt = nowIso(),
): PortSkip {
  writableDb()
  const id = (
    db()
      .query(
        `INSERT INTO port_skip (record_id, pair_id, candidate, reason, skipped_at) VALUES (?,?,?,?,?)
     RETURNING id`,
      )
      .get(newRecordId(), pairId, candidate, reason, skippedAt) as { id: number }
  ).id
  return db()
    .query('SELECT id,pair_id,candidate,reason,skipped_at FROM port_skip WHERE id=?')
    .get(id) as PortSkip
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('invalid string array in port ledger')
  }
  return parsed
}

export function ledgerRef(targetProjectId: string, taskKey: string): LedgerRef | null {
  const rows = db()
    .query(
      'SELECT task_key,target_project_record_id,note,created_at,resolved_at,space_id FROM port_ref WHERE target_project_record_id=? AND task_key=?',
    )
    .all(targetProjectId, taskKey) as (Omit<LedgerRef, 'sources'> & { space_id: string | null })[]
  const spaceId = projectSpace(targetProjectId)
  const ref = overlayPortItems(
    rows.filter((row) => row.space_id === null),
    rows.filter((row) => row.space_id === spaceId),
    (row) => `${row.target_project_record_id}:${row.task_key}`,
  )[0]
  if (!ref) return null
  const sourceRows = db()
    .query(
      `SELECT source_project_record_id, commits, paths, note FROM port_ref_source
     WHERE target_project_record_id=? AND task_key=? AND space_id IS ? ORDER BY id`,
    )
    .all(targetProjectId, taskKey, ref.space_id) as {
    source_project_record_id: string
    commits: string
    paths: string
    note: string
  }[]
  const { space_id: _spaceId, ...visibleRef } = ref
  return {
    ...visibleRef,
    sources: sourceRows.map((row) => ({
      source_project_record_id: row.source_project_record_id,
      commits: parseStringArray(row.commits),
      paths: parseStringArray(row.paths),
      note: row.note,
    })),
  }
}

export function listLedgerRefs(includeResolved = false): LedgerRef[] {
  const keys = db()
    .query(
      `SELECT target_project_record_id,task_key FROM port_ref${includeResolved ? '' : ' WHERE resolved_at IS NULL'} ORDER BY target_project_record_id,task_key`,
    )
    .all() as { target_project_record_id: string; task_key: string }[]
  const unique = new Map<string, { target_project_record_id: string; task_key: string }>()
  for (const key of keys) unique.set(`${key.target_project_record_id}:${key.task_key}`, key)
  return [...unique.values()]
    .map(({ target_project_record_id, task_key }) => ledgerRef(target_project_record_id, task_key))
    .filter((row): row is LedgerRef => Boolean(row && (includeResolved || !row.resolved_at)))
}

export function setLedgerRefLocal(input: {
  taskKey: string
  targetProjectId: string
  note: string
  sources: LedgerSource[]
  createdAt?: string
}): LedgerRef {
  writableDb()
  if (input.sources.length === 0) throw new Error('a ledger ref needs at least one source project')
  if (
    new Set(input.sources.map((source) => source.source_project_record_id)).size !==
    input.sources.length
  ) {
    throw new Error('a ledger ref may name each source project only once')
  }
  writeTransaction(() => {
    db()
      .query(
        `INSERT INTO port_ref (record_id, task_key, target_project_record_id, note, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(target_project_record_id,task_key) WHERE space_id IS NULL DO UPDATE SET note=excluded.note`,
      )
      .run(
        newRecordId(),
        input.taskKey,
        input.targetProjectId,
        input.note,
        input.createdAt ?? nowIso(),
      )
    db()
      .query('DELETE FROM port_ref_source WHERE target_project_record_id=? AND task_key=?')
      .run(input.targetProjectId, input.taskKey)
    const insert = db().query(
      `INSERT INTO port_ref_source
         (record_id, task_key, target_project_record_id, source_project_record_id, commits, paths, note) VALUES (?,?,?,?,?,?,?)`,
    )
    for (const source of input.sources) {
      insert.run(
        newRecordId(),
        input.taskKey,
        input.targetProjectId,
        source.source_project_record_id,
        JSON.stringify(source.commits),
        JSON.stringify(source.paths),
        source.note,
      )
    }
  })
  return ledgerRef(input.targetProjectId, input.taskKey)!
}

function removeLedgerRefLocal(targetProjectId: string, taskKey: string): boolean {
  writableDb()
  return (
    db()
      .query('DELETE FROM port_ref WHERE target_project_record_id=? AND task_key=?')
      .run(targetProjectId, taskKey).changes > 0
  )
}

export function resolveLedgerRefLocal(
  targetProjectId: string,
  taskKey: string,
  resolvedAt = nowIso(),
): LedgerRef | null {
  writableDb()
  const existing = ledgerRef(targetProjectId, taskKey)
  if (!existing || existing.resolved_at) return existing
  db()
    .query(
      'UPDATE port_ref SET resolved_at=? WHERE target_project_record_id=? AND task_key=? AND resolved_at IS NULL',
    )
    .run(resolvedAt, targetProjectId, taskKey)
  return ledgerRef(targetProjectId, taskKey)
}

export function listDoctrineRules(includeRetired = true): DoctrineRule[] {
  const rows = db()
    .query(
      `SELECT number,title,body,created_at,retired_at,space_id FROM port_doctrine${includeRetired ? '' : ' WHERE retired_at IS NULL'} ORDER BY number`,
    )
    .all() as (DoctrineRule & { space_id: string | null })[]
  const spaceId = activeRecordSpace(db())
  return overlayPortItems(
    rows.filter((row) => row.space_id === null),
    rows.filter((row) => row.space_id === spaceId),
    (row) => String(row.number),
  ).map(({ space_id: _spaceId, ...row }) => row)
}

export function addDoctrineRuleLocal(
  number: number,
  title: string,
  body: string,
  createdAt = nowIso(),
): DoctrineRule {
  writableDb()
  db()
    .query(
      `INSERT INTO port_doctrine (record_id, number, title, body, created_at) VALUES (?,?,?,?,?)`,
    )
    .run(newRecordId(), number, title, body, createdAt)
  return db()
    .query('SELECT number,title,body,created_at,retired_at FROM port_doctrine WHERE number=?')
    .get(number) as DoctrineRule
}

export function retireDoctrineRuleLocal(number: number, retiredAt = nowIso()): boolean {
  writableDb()
  return (
    db()
      .query('UPDATE port_doctrine SET retired_at=? WHERE number=? AND retired_at IS NULL')
      .run(retiredAt, number).changes > 0
  )
}

function storedBaseline(pairId: number): (PortBaseline & SpaceRow) | null {
  return db()
    .query(
      'SELECT pair_id,source_commit,scanned_at,record_id,space_id,version FROM port_baseline WHERE pair_id=?',
    )
    .get(pairId) as (PortBaseline & SpaceRow) | null
}
function storedPair(pairId: number): (PortPair & SpaceRow) | null {
  return db()
    .query(
      'SELECT id,source_project_record_id,target_project_record_id,created_at,record_id,space_id FROM port_pair WHERE id=?',
    )
    .get(pairId) as (PortPair & SpaceRow) | null
}
function storedRef(targetProjectId: string, taskKey: string): SpaceRow | null {
  const spaceId = projectSpace(targetProjectId)
  return db()
    .query(
      'SELECT record_id,space_id,version FROM port_ref WHERE target_project_record_id=? AND task_key=? AND space_id IS ?',
    )
    .get(targetProjectId, taskKey, spaceId) as SpaceRow | null
}

export function setBaselineForProjects(
  sourceProjectId: string,
  targetProjectId: string,
  sourceCommit: string | null,
  scannedAt: string | null = sourceCommit === null ? null : nowIso(),
) {
  return applyRecordWriteAuthority({
    local: () => {
      const pair = addPairLocal(sourceProjectId, targetProjectId)
      return { pair, baseline: setBaselineLocal(pair.id, sourceCommit, scannedAt) }
    },
    hosted: async () => {
      const spaceId = await hostedSpace(targetProjectId)
      const currentPair = pairByProjects(sourceProjectId, targetProjectId)
      const current = currentPair ? storedBaseline(currentPair.id) : null
      const response = await recordApiClient().writePort!(
        {
          action: 'set_baseline',
          sourceProjectId,
          targetProjectId,
          sourceCommit,
          scannedAt,
          expectedVersion: current?.space_id === spaceId ? (current.version ?? null) : null,
        },
        { destinationSpaceId: spaceId },
      )
      applyPortWriteResponse(db(), response)
      const pair = pairByProjects(sourceProjectId, targetProjectId)!
      return { pair, baseline: baselineForPair(pair.id)! }
    },
  })
}

export function addSkip(pairId: number, candidate: string, reason: string, skippedAt = nowIso()) {
  const pair = storedPair(pairId)
  if (!pair) throw new Error(`unknown port pair ${pairId}`)
  return applyRecordWriteAuthority({
    local: () => addSkipLocal(pairId, candidate, reason, skippedAt),
    hosted: async () => {
      const spaceId = await hostedSpace(pair.target_project_record_id)
      const response = await recordApiClient().writePort!(
        {
          action: 'add_skip',
          sourceProjectId: pair.source_project_record_id,
          targetProjectId: pair.target_project_record_id,
          candidate,
          reason,
          skippedAt,
        },
        { destinationSpaceId: spaceId },
      )
      applyPortWriteResponse(db(), response)
      return listSkips(
        pairByProjects(pair.source_project_record_id, pair.target_project_record_id)!.id,
      ).find((row) => row.candidate === candidate)!
    },
  })
}

export function setLedgerRef(input: {
  taskKey: string
  targetProjectId: string
  note: string
  sources: LedgerSource[]
  createdAt?: string
}) {
  return applyRecordWriteAuthority({
    local: () => setLedgerRefLocal(input),
    hosted: async () => {
      const spaceId = await hostedSpace(input.targetProjectId)
      const current = storedRef(input.targetProjectId, input.taskKey)
      const response = await recordApiClient().writePort!(
        {
          action: 'set_ref',
          taskKey: input.taskKey,
          targetProjectId: input.targetProjectId,
          note: input.note,
          sources: input.sources.map((source) => ({
            sourceProjectId: source.source_project_record_id,
            commits: source.commits,
            paths: source.paths,
            note: source.note,
          })),
          createdAt: input.createdAt ?? nowIso(),
          expectedVersion: current?.space_id === spaceId ? (current.version ?? null) : null,
        },
        { destinationSpaceId: spaceId },
      )
      applyPortWriteResponse(db(), response)
      return ledgerRef(input.targetProjectId, input.taskKey)!
    },
  })
}

export function resolveLedgerRef(targetProjectId: string, taskKey: string, resolvedAt = nowIso()) {
  return applyRecordWriteAuthority({
    local: () => resolveLedgerRefLocal(targetProjectId, taskKey, resolvedAt),
    hosted: async () => {
      const spaceId = await hostedSpace(targetProjectId)
      const current = storedRef(targetProjectId, taskKey)
      if (!current?.version) return null
      const response = await recordApiClient().writePort!(
        {
          action: 'resolve_ref',
          targetProjectId,
          taskKey,
          expectedVersion: current.version,
          at: resolvedAt,
        },
        { destinationSpaceId: spaceId },
      )
      applyPortWriteResponse(db(), response)
      return ledgerRef(targetProjectId, taskKey)
    },
  })
}

export function removeLedgerRef(targetProjectId: string, taskKey: string) {
  return applyRecordWriteAuthority({
    local: () => removeLedgerRefLocal(targetProjectId, taskKey),
    hosted: async () => {
      const spaceId = await hostedSpace(targetProjectId)
      const current = storedRef(targetProjectId, taskKey)
      if (!current?.version) return false
      const response = await recordApiClient().writePort!(
        {
          action: 'delete_ref',
          targetProjectId,
          taskKey,
          expectedVersion: current.version,
          at: nowIso(),
        },
        { destinationSpaceId: spaceId },
      )
      applyPortWriteResponse(db(), response)
      return true
    },
  })
}

export function addDoctrineRule(number: number, title: string, body: string, createdAt = nowIso()) {
  return applyRecordWriteAuthority({
    local: () => addDoctrineRuleLocal(number, title, body, createdAt),
    hosted: async () => {
      const spaceId = await hostedSpace()
      const response = await recordApiClient().writePort!(
        { action: 'add_doctrine', number, title, body, createdAt },
        { destinationSpaceId: spaceId },
      )
      applyPortWriteResponse(db(), response)
      return listDoctrineRules().find((row) => row.number === number)!
    },
  })
}

export function retireDoctrineRule(number: number, retiredAt = nowIso()) {
  return applyRecordWriteAuthority({
    local: () => retireDoctrineRuleLocal(number, retiredAt),
    hosted: async () => {
      const spaceId = await hostedSpace()
      const current = db()
        .query<{ version: number }, [string, number]>(
          'SELECT version FROM port_doctrine WHERE space_id=? AND number=?',
        )
        .get(spaceId, number)
      if (!current) return false
      const response = await recordApiClient().writePort!(
        { action: 'retire_doctrine', number, expectedVersion: current.version, retiredAt },
        { destinationSpaceId: spaceId },
      )
      applyPortWriteResponse(db(), response)
      return true
    },
  })
}
