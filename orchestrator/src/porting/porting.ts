import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { activeRecordSpace, effectiveProjectSpace } from '../project-space.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { applyPortWriteResponse } from '../record/record-cache-port.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { type HubTaskReader, resolveHubTaskReference } from '../workflow/workflow-task-reference.ts'
import { workerStoreWriteRefusal } from '../worker-store-write.ts'

export type PortPair = {
  record_id: string
  source_project_record_id: string
  target_project_record_id: string
  created_at: string
}

export type PortBaseline = {
  pair_record_id: string
  source_commit: string | null
  scanned_at: string | null
}

export type PortSkip = {
  record_id: string
  pair_record_id: string
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
function assertPortWriteAllowed(operation: string): void {
  writableDb()
  const refusal = workerStoreWriteRefusal('port', operation, process.env)
  if (refusal) throw new Error(refusal)
}

export function pairByProjects(sourceProjectId: string, targetProjectId: string): PortPair | null {
  return pairByProjectsInSpace(sourceProjectId, targetProjectId, projectSpace(targetProjectId))
}
function pairByProjectsInSpace(
  sourceProjectId: string,
  targetProjectId: string,
  spaceId: string | null,
): PortPair | null {
  const selected = db()
    .query(
      'SELECT record_id,source_project_record_id,target_project_record_id,created_at,space_id FROM port_pair WHERE source_project_record_id=? AND target_project_record_id=? AND space_id IS ?',
    )
    .get(sourceProjectId, targetProjectId, spaceId) as
    | (PortPair & { space_id: string | null })
    | null
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
    const pair = pairByProjectsInSpace(sourceProjectId, targetProjectId, null)!
    db()
      .query(
        `INSERT INTO port_baseline (record_id, pair_record_id, source_commit, scanned_at) VALUES (?,?,NULL,NULL)
       ON CONFLICT(pair_record_id) DO NOTHING`,
      )
      .run(newRecordId(), pair.record_id)
  })
  return pairByProjectsInSpace(sourceProjectId, targetProjectId, null)!
}

export function baselineForPair(pairRecordId: string): PortBaseline | null {
  return db()
    .query(
      'SELECT pair_record_id,source_commit,scanned_at FROM port_baseline WHERE pair_record_id=?',
    )
    .get(pairRecordId) as PortBaseline | null
}

export function setBaselineLocal(
  pairRecordId: string,
  sourceCommit: string | null,
  scannedAt: string | null = sourceCommit === null ? null : nowIso(),
): PortBaseline {
  writableDb()
  db()
    .query(
      `INSERT INTO port_baseline (record_id, pair_record_id, source_commit, scanned_at) VALUES (?,?,?,?)
     ON CONFLICT(pair_record_id) DO UPDATE SET
       source_commit=excluded.source_commit, scanned_at=excluded.scanned_at`,
    )
    .run(newRecordId(), pairRecordId, sourceCommit, scannedAt)
  return baselineForPair(pairRecordId)!
}

export function listSkips(pairRecordId: string): PortSkip[] {
  const pair = db()
    .query<PortPair & { space_id: string | null }, [string]>(
      'SELECT record_id,source_project_record_id,target_project_record_id,created_at,space_id FROM port_pair WHERE record_id=?',
    )
    .get(pairRecordId)
  if (!pair) return []
  const spaceId = projectSpace(pair.target_project_record_id)
  const rows = db()
    .query(
      `SELECT s.record_id,s.pair_record_id,s.candidate,s.reason,s.skipped_at,p.space_id
       FROM port_skip s JOIN port_pair p ON p.record_id=s.pair_record_id
       WHERE p.source_project_record_id=? AND p.target_project_record_id=?
         AND p.space_id IS ?
       ORDER BY s.skipped_at,s.record_id`,
    )
    .all(pair.source_project_record_id, pair.target_project_record_id, spaceId) as (PortSkip & {
    space_id: string | null
  })[]
  return rows.map(({ space_id: _spaceId, ...row }) => row)
}

export function addSkipLocal(
  pairRecordId: string,
  candidate: string,
  reason: string,
  skippedAt = nowIso(),
): PortSkip {
  writableDb()
  const recordId = (
    db()
      .query(
        `INSERT INTO port_skip (record_id, pair_record_id, candidate, reason, skipped_at) VALUES (?,?,?,?,?)
     RETURNING record_id`,
      )
      .get(newRecordId(), pairRecordId, candidate, reason, skippedAt) as { record_id: string }
  ).record_id
  return db()
    .query(
      'SELECT record_id,pair_record_id,candidate,reason,skipped_at FROM port_skip WHERE record_id=?',
    )
    .get(recordId) as PortSkip
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('invalid string array in port ledger')
  }
  return parsed
}

export function ledgerRef(targetProjectId: string, taskKey: string): LedgerRef | null {
  return ledgerRefInSpace(targetProjectId, taskKey, projectSpace(targetProjectId))
}
function ledgerRefInSpace(
  targetProjectId: string,
  taskKey: string,
  spaceId: string | null,
): LedgerRef | null {
  const ref = db()
    .query(
      'SELECT task_key,target_project_record_id,note,created_at,resolved_at,space_id FROM port_ref WHERE target_project_record_id=? AND task_key=? AND space_id IS ?',
    )
    .get(targetProjectId, taskKey, spaceId) as
    | (Omit<LedgerRef, 'sources'> & { space_id: string | null })
    | null
  if (!ref) return null
  const sourceRows = db()
    .query(
      `SELECT s.source_project_record_id,s.commits,s.paths,s.note FROM port_ref_source s
       JOIN port_ref r ON r.record_id=s.ref_record_id
       WHERE r.target_project_record_id=? AND r.task_key=? AND s.space_id IS ? ORDER BY s.position`,
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
  const keys = (
    db().query('SELECT record_id,name FROM project ORDER BY record_id').all() as {
      record_id: string
      name: string
    }[]
  ).flatMap((project) => {
    const spaceId = effectiveProjectSpace(db(), project.name)
    return db()
      .query(
        `SELECT target_project_record_id,task_key FROM port_ref
         WHERE target_project_record_id=? AND space_id IS ? ${includeResolved ? '' : 'AND resolved_at IS NULL'}
         ORDER BY task_key`,
      )
      .all(project.record_id, spaceId) as {
      target_project_record_id: string
      task_key: string
    }[]
  })
  return keys
    .map(({ target_project_record_id, task_key }) => ledgerRef(target_project_record_id, task_key))
    .filter((row): row is LedgerRef => Boolean(row && (includeResolved || !row.resolved_at)))
}

export function setLedgerRefLocal(input: {
  taskKey: string
  targetProjectId: string
  note: string
  sources: LedgerSource[]
  createdAt?: string
  taskRecordId?: string | null
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
        `INSERT INTO port_ref (record_id, task_key, task_record_id, target_project_record_id, note, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(target_project_record_id,task_key) WHERE space_id IS NULL DO UPDATE SET
         task_record_id=excluded.task_record_id,note=excluded.note`,
      )
      .run(
        newRecordId(),
        input.taskKey,
        input.taskRecordId ?? null,
        input.targetProjectId,
        input.note,
        input.createdAt ?? nowIso(),
      )
    db()
      .query(
        'DELETE FROM port_ref_source WHERE ref_record_id=(SELECT record_id FROM port_ref WHERE target_project_record_id=? AND task_key=? AND space_id IS NULL)',
      )
      .run(input.targetProjectId, input.taskKey)
    const ref = db()
      .query<{ record_id: string }, [string, string]>(
        'SELECT record_id FROM port_ref WHERE target_project_record_id=? AND task_key=? AND space_id IS NULL',
      )
      .get(input.targetProjectId, input.taskKey)!
    const insert = db().query(
      `INSERT INTO port_ref_source
         (record_id, ref_record_id, source_project_record_id, commits, paths, note, position) VALUES (?,?,?,?,?,?,?)`,
    )
    for (const [position, source] of input.sources.entries()) {
      insert.run(
        newRecordId(),
        ref.record_id,
        source.source_project_record_id,
        JSON.stringify(source.commits),
        JSON.stringify(source.paths),
        source.note,
        position,
      )
    }
  })
  return ledgerRefInSpace(input.targetProjectId, input.taskKey, null)!
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
  const existing = ledgerRefInSpace(targetProjectId, taskKey, null)
  if (!existing || existing.resolved_at) return existing
  db()
    .query(
      'UPDATE port_ref SET resolved_at=? WHERE target_project_record_id=? AND task_key=? AND resolved_at IS NULL',
    )
    .run(resolvedAt, targetProjectId, taskKey)
  return ledgerRefInSpace(targetProjectId, taskKey, null)
}

export function listDoctrineRules(includeRetired = true): DoctrineRule[] {
  const spaceId = activeRecordSpace(db())
  const rows = db()
    .query(
      'SELECT number,title,body,created_at,retired_at,space_id FROM port_doctrine WHERE space_id IS ? ORDER BY number',
    )
    .all(spaceId) as (DoctrineRule & { space_id: string | null })[]
  return rows
    .filter((row) => includeRetired || row.retired_at === null)
    .map(({ space_id: _spaceId, ...row }) => row)
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

function storedBaseline(pairRecordId: string): (PortBaseline & SpaceRow) | null {
  return db()
    .query(
      'SELECT pair_record_id,source_commit,scanned_at,record_id,space_id,version FROM port_baseline WHERE pair_record_id=?',
    )
    .get(pairRecordId) as (PortBaseline & SpaceRow) | null
}
function storedPair(pairRecordId: string): (PortPair & SpaceRow) | null {
  return db()
    .query(
      'SELECT record_id,source_project_record_id,target_project_record_id,created_at,space_id FROM port_pair WHERE record_id=?',
    )
    .get(pairRecordId) as (PortPair & SpaceRow) | null
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
  assertPortWriteAllowed('set port baseline')
  return applyRecordWriteAuthority({
    local: () => {
      const pair = addPairLocal(sourceProjectId, targetProjectId)
      return { pair, baseline: setBaselineLocal(pair.record_id, sourceCommit, scannedAt) }
    },
    hosted: async () => {
      const spaceId = await hostedSpace(targetProjectId)
      const currentPair = pairByProjects(sourceProjectId, targetProjectId)
      const current = currentPair ? storedBaseline(currentPair.record_id) : null
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
      return { pair, baseline: baselineForPair(pair.record_id)! }
    },
  })
}

export function addSkip(
  pairRecordId: string,
  candidate: string,
  reason: string,
  skippedAt = nowIso(),
) {
  assertPortWriteAllowed('record port skip')
  const pair = storedPair(pairRecordId)
  if (!pair) throw new Error(`unknown port pair ${pairRecordId}`)
  return applyRecordWriteAuthority({
    local: () => addSkipLocal(pairRecordId, candidate, reason, skippedAt),
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
        pairByProjects(pair.source_project_record_id, pair.target_project_record_id)!.record_id,
      ).find((row) => row.candidate === candidate)!
    },
  })
}

export async function setLedgerRef(
  input: {
    taskKey: string
    targetProjectId: string
    note: string
    sources: LedgerSource[]
    createdAt?: string
  },
  hubTaskReader?: HubTaskReader,
) {
  assertPortWriteAllowed('set port ledger ref')
  const task = await resolveHubTaskReference(
    projectName(input.targetProjectId),
    input.taskKey,
    hubTaskReader,
  )
  return applyRecordWriteAuthority({
    local: () => setLedgerRefLocal({ ...input, taskRecordId: task?.record_id ?? null }),
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
  assertPortWriteAllowed('resolve port ledger ref')
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
  assertPortWriteAllowed('delete port ledger ref')
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
  assertPortWriteAllowed('add port doctrine rule')
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
  assertPortWriteAllowed('retire port doctrine rule')
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
